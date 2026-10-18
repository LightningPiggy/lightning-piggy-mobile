package com.lightningpiggy.ambersigner

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException

class AmberSignerModule : Module() {
    /**
     * The one Amber Intent that may be outstanding. Amber shows one approval
     * sheet at a time, so the module is single-flight: a second launch while
     * this is set rejects with `BUSY`.
     */
    private class PendingRequest(
        val op: Int,
        /** Unique per launch, so a late result can never settle a newer request. */
        val requestCode: Int,
        val promise: Promise,
        val startedAtMs: Long,
        /** Lightning Piggy's activity has paused since launch (Amber came up). */
        var leftForeground: Boolean,
    )

    // All request state is confined to the main thread: activity results and
    // lifecycle callbacks arrive there, and launches are posted there, so a
    // launch can never interleave with a pause/resume or a result.
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pending: PendingRequest? = null
    private var nextSeq = 0
    private var inForeground = true
    /** Bumped on every pause; a resume check only fires if no pause followed it. */
    private var pauseCount = 0
    /** Set (from any thread) when the module is torn down; posted work checks it. */
    @Volatile private var destroyed = false
    /**
     * Codes of requests settled without a result (resume, watchdog, eviction)
     * whose Amber activity may still answer. Never reallocated while held, so
     * a late result can't match a newer request; dropped once it arrives.
     */
    private val abandonedCodes = HashSet<Int>()

    companion object {
        private const val TAG = "AmberSigner"

        // Request codes are REQUEST_CODE_BASE | seq (12 bits): the high nibble
        // marks the code as ours (other modules' results also reach
        // OnActivityResult) and the sequence ties a result to its launch.
        // Max 0xAFFF, inside the 16 bits startActivityForResult allows.
        private const val REQUEST_CODE_BASE = 0xA000
        private const val SEQ_MASK = 0x0FFF

        private const val OP_GET_PUBLIC_KEY = 1
        private const val OP_SIGN_EVENT = 2
        private const val OP_NIP04_ENCRYPT = 3
        private const val OP_NIP04_DECRYPT = 4
        private const val OP_NIP44_ENCRYPT = 5
        private const val OP_NIP44_DECRYPT = 6

        // Results are delivered before the activity resumes, so a resume with
        // the request still pending means none is coming. The short grace is
        // belt-and-braces against any dispatch reordering.
        private const val RESUME_GRACE_MS = 500L
        // How long Lightning Piggy may keep window focus after a launch before
        // we conclude Amber never came up. Re-armed while focus is elsewhere.
        private const val LAUNCH_WATCHDOG_MS = 15_000L
        // Backstop: a request this old is evicted by the next launch rather
        // than answering it with BUSY forever.
        private const val STALE_AFTER_MS = 3 * 60_000L

        private const val AMBER_PACKAGE = "com.greenart7c3.nostrsigner"
        private const val AMBER_AUTHORITY = "com.greenart7c3.nostrsigner"

        private fun isAmberRequestCode(code: Int) = (code and SEQ_MASK.inv()) == REQUEST_CODE_BASE

        private fun noResult(message: String) = CodedException("NO_RESULT", message, null)
    }

    /** Next request code not held by an abandoned request, or null if none is free (main thread). */
    private fun allocateRequestCode(): Int? {
        repeat(SEQ_MASK + 1) {
            val code = REQUEST_CODE_BASE or (nextSeq++ and SEQ_MASK)
            if (code !in abandonedCodes) return code
        }
        return null
    }

    /**
     * Settles [req] as NO_RESULT if it is still the outstanding request, and
     * remembers its code so a late result is ignored (main thread).
     */
    private fun abandon(req: PendingRequest, message: String) {
        if (pending !== req) return
        pending = null
        abandonedCodes.add(req.requestCode)
        req.promise.reject(noResult(message))
    }

    override fun definition() = ModuleDefinition {
        Name("AmberSigner")

        OnActivityEntersBackground {
            inForeground = false
            pauseCount++
            pending?.leftForeground = true
        }

        // Back in Lightning Piggy with the request still pending: Amber handed
        // focus elsewhere, or the user switched away from its sheet. No result
        // will arrive for it, so settle it instead of leaving it to block every
        // later request with BUSY (#1186). A pause inside the grace window (the
        // user went straight back to Amber) cancels the check.
        OnActivityEntersForeground {
            inForeground = true
            val req = pending?.takeIf { it.leftForeground } ?: return@OnActivityEntersForeground
            val pausesAtResume = pauseCount
            mainHandler.postDelayed({
                if (!destroyed && inForeground && pauseCount == pausesAtResume) {
                    abandon(req, "Returned to Lightning Piggy without a result from Amber")
                }
            }, RESUME_GRACE_MS)
        }

        // May run off the main thread: flag first so anything posted after the
        // purge (e.g. a launch from a ContentResolver query still in flight)
        // sees it and does nothing.
        OnDestroy {
            destroyed = true
            mainHandler.removeCallbacksAndMessages(null)
        }

        OnActivityResult { _, payload ->
            val requestCode = payload.requestCode
            val resultCode = payload.resultCode
            val data = payload.data

            if (!isAmberRequestCode(requestCode)) return@OnActivityResult
            val req = pending?.takeIf { it.requestCode == requestCode }
            if (req == null) {
                // A late result for a request we already settled — never apply
                // it to a newer request.
                abandonedCodes.remove(requestCode)
                Log.w(TAG, "Ignoring Amber result for a settled request (code=$requestCode)")
                return@OnActivityResult
            }
            pending = null
            val promise = req.promise

            if (resultCode != Activity.RESULT_OK) {
                promise.reject(CodedException("CANCELLED", "The request was declined or closed in Amber", null))
                return@OnActivityResult
            }

            when (req.op) {
                OP_GET_PUBLIC_KEY -> {
                    val result = data?.getStringExtra("signature") ?: ""
                    val packageName = data?.getStringExtra("package") ?: AMBER_PACKAGE
                    promise.resolve(mapOf(
                        "pubkey" to result,
                        "package" to packageName
                    ))
                }
                OP_SIGN_EVENT -> {
                    val result = data?.getStringExtra("signature") ?: ""
                    val eventJson = data?.getStringExtra("event") ?: ""
                    promise.resolve(mapOf(
                        "signature" to result,
                        "event" to eventJson
                    ))
                }
                OP_NIP04_ENCRYPT,
                OP_NIP04_DECRYPT,
                OP_NIP44_ENCRYPT,
                OP_NIP44_DECRYPT -> {
                    val result = data?.getStringExtra("result")
                        ?: data?.getStringExtra("signature")
                        ?: ""
                    promise.resolve(mapOf("result" to result))
                }
                else -> {
                    promise.reject(CodedException("UNKNOWN", "Unknown request code", null))
                }
            }
        }

        AsyncFunction("getPublicKey") { permissionsJson: String?, promise: Promise ->
            launchIntent(op = OP_GET_PUBLIC_KEY, promise = promise) { activity, requestCode ->
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"))
                intent.`package` = AMBER_PACKAGE
                intent.putExtra("type", "get_public_key")
                // Nullable trailing argument keeps callers without permissions compatible.
                if (permissionsJson != null) {
                    intent.putExtra("permissions", permissionsJson)
                }
                activity.startActivityForResult(intent, requestCode)
            }
        }

        AsyncFunction("signEvent") { eventJson: String, eventId: String, currentUser: String, promise: Promise ->
            // Fast path: try ContentResolver (works silently for pre-approved perms).
            val resolverResult = queryContentProvider(
                authority = "$AMBER_AUTHORITY.SIGN_EVENT",
                projection = arrayOf(eventJson, eventId.ifEmpty { "" }, currentUser),
                eventColumn = "event",
                signatureColumn = "signature",
            )
            if (resolverResult != null) {
                promise.resolve(mapOf(
                    "signature" to (resolverResult["signature"] ?: ""),
                    "event" to (resolverResult["event"] ?: ""),
                ))
                return@AsyncFunction
            }

            // Fall back to Intent (user approval).
            launchIntent(op = OP_SIGN_EVENT, promise = promise) { activity, requestCode ->
                // Don't Uri.encode the JSON — Amber 4.x parses intent.data as already-decoded JSON. URL-encoded payloads silently fail AmberEvent.fromJson, the intent gets dropped, and Amber falls back to its Applications screen instead of opening the sign sheet. NIP-55 / Damus / Citrine all pass raw JSON.
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:$eventJson"))
                intent.`package` = AMBER_PACKAGE
                intent.putExtra("type", "sign_event")
                // Empty `id` makes Amber silently reject kind-13 (NIP-17 seal) intents — UUID fallback so seal/wrap signing reaches the approval flow.
                intent.putExtra("id", eventId.ifEmpty { java.util.UUID.randomUUID().toString() })
                intent.putExtra("current_user", currentUser)
                activity.startActivityForResult(intent, requestCode)
            }
        }

        AsyncFunction("nip04Encrypt") { plaintext: String, pubkey: String, currentUser: String, promise: Promise ->
            handleCryptoOp(
                type = "nip04_encrypt",
                authority = "$AMBER_AUTHORITY.NIP04_ENCRYPT",
                payload = plaintext,
                pubkey = pubkey,
                currentUser = currentUser,
                op = OP_NIP04_ENCRYPT,
                promise = promise,
            )
        }

        AsyncFunction("nip04Decrypt") { ciphertext: String, pubkey: String, currentUser: String, promise: Promise ->
            handleCryptoOp(
                type = "nip04_decrypt",
                authority = "$AMBER_AUTHORITY.NIP04_DECRYPT",
                payload = ciphertext,
                pubkey = pubkey,
                currentUser = currentUser,
                op = OP_NIP04_DECRYPT,
                promise = promise,
            )
        }

        AsyncFunction("nip44Encrypt") { plaintext: String, pubkey: String, currentUser: String, promise: Promise ->
            handleCryptoOp(
                type = "nip44_encrypt",
                authority = "$AMBER_AUTHORITY.NIP44_ENCRYPT",
                payload = plaintext,
                pubkey = pubkey,
                currentUser = currentUser,
                op = OP_NIP44_ENCRYPT,
                promise = promise,
            )
        }

        AsyncFunction("nip44Decrypt") { ciphertext: String, pubkey: String, currentUser: String, promise: Promise ->
            handleCryptoOp(
                type = "nip44_decrypt",
                authority = "$AMBER_AUTHORITY.NIP44_DECRYPT",
                payload = ciphertext,
                pubkey = pubkey,
                currentUser = currentUser,
                op = OP_NIP44_DECRYPT,
                promise = promise,
            )
        }

        // Silent-only variant — only uses the ContentResolver fast-path and
        // rejects if Amber hasn't pre-approved the op. Used by the inbox
        // unwrap path so we never surface a dialog per wrap on tab focus;
        // permission is granted once via the Account toggle and subsequent
        // calls resolve silently.
        AsyncFunction("nip44DecryptSilent") { ciphertext: String, pubkey: String, currentUser: String, promise: Promise ->
            val resolverResult = queryContentProvider(
                authority = "$AMBER_AUTHORITY.NIP44_DECRYPT",
                projection = arrayOf(ciphertext, pubkey, currentUser),
                eventColumn = null,
                signatureColumn = "result",
            )
            if (resolverResult != null) {
                promise.resolve(mapOf("result" to (resolverResult["result"] ?: "")))
            } else {
                promise.reject(CodedException("PERMISSION_NOT_GRANTED", "Amber nip44_decrypt not pre-approved", null))
            }
        }

        AsyncFunction("isInstalled") { promise: Promise ->
            val activity = appContext.currentActivity
            if (activity == null) {
                promise.resolve(false)
                return@AsyncFunction
            }

            try {
                activity.packageManager.getPackageInfo(AMBER_PACKAGE, 0)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }
    }

    private fun handleCryptoOp(
        type: String,
        authority: String,
        payload: String,
        pubkey: String,
        currentUser: String,
        op: Int,
        promise: Promise,
    ) {
        // Fast path: ContentResolver (no UI).
        val resolverResult = queryContentProvider(
            authority = authority,
            projection = arrayOf(payload, pubkey, currentUser),
            eventColumn = null,
            signatureColumn = "result",
        )
        if (resolverResult != null) {
            promise.resolve(mapOf("result" to (resolverResult["result"] ?: "")))
            return
        }

        // Fall back to Intent (user approval dialog).
        launchIntent(op = op, promise = promise) { activity, requestCode ->
            // Raw payload, not Uri.encode'd — same reason as signEvent above.
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:$payload"))
            intent.`package` = AMBER_PACKAGE
            intent.putExtra("type", type)
            intent.putExtra("id", java.util.UUID.randomUUID().toString())
            intent.putExtra("pubkey", pubkey)
            intent.putExtra("current_user", currentUser)
            activity.startActivityForResult(intent, requestCode)
        }
    }

    /**
     * Queries Amber's ContentProvider for a pre-approved operation.
     * Returns null when the user hasn't pre-approved (caller should fall back to Intent).
     * Returns a map of column→value on success.
     */
    private fun queryContentProvider(
        authority: String,
        projection: Array<String>,
        eventColumn: String?,
        signatureColumn: String,
    ): Map<String, String>? {
        val context = appContext.reactContext ?: return null
        val uri = Uri.parse("content://$authority")
        return try {
            context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) return null
                val rejectedIdx = cursor.getColumnIndex("rejected")
                if (rejectedIdx >= 0) {
                    val rejected = cursor.getString(rejectedIdx)
                    if (rejected == "true") return null
                }
                val result = mutableMapOf<String, String>()
                val sigIdx = cursor.getColumnIndex(signatureColumn)
                if (sigIdx >= 0) result[signatureColumn] = cursor.getString(sigIdx) ?: ""
                if (eventColumn != null) {
                    val evtIdx = cursor.getColumnIndex(eventColumn)
                    if (evtIdx >= 0) result[eventColumn] = cursor.getString(evtIdx) ?: ""
                }
                if (result.isEmpty()) null else result
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun launchIntent(
        op: Int,
        promise: Promise,
        build: (activity: Activity, requestCode: Int) -> Unit,
    ) {
        mainHandler.post { if (!destroyed) launchOnMain(op, promise, build) }
    }

    private fun launchOnMain(
        op: Int,
        promise: Promise,
        build: (activity: Activity, requestCode: Int) -> Unit,
    ) {
        val activity = appContext.currentActivity
        if (activity == null) {
            promise.reject(CodedException("NO_ACTIVITY", "No current activity", null))
            return
        }
        val now = SystemClock.elapsedRealtime()
        pending?.let { current ->
            if (now - current.startedAtMs >= STALE_AFTER_MS) {
                abandon(current, "Amber never answered an earlier request")
            }
        }
        if (pending != null) {
            promise.reject(CodedException("BUSY", "Another Amber request is already in progress", null))
            return
        }
        val requestCode = allocateRequestCode()
        if (requestCode == null) {
            promise.reject(CodedException("LAUNCH_FAILED", "No free Amber request code", null))
            return
        }
        val req = PendingRequest(
            op = op,
            requestCode = requestCode,
            promise = promise,
            startedAtMs = now,
            // Launched while backgrounded: the next resume settles it.
            leftForeground = !inForeground,
        )
        pending = req
        try {
            build(activity, req.requestCode)
        } catch (e: Exception) {
            pending = null
            promise.reject(CodedException("LAUNCH_FAILED", "Failed to launch Amber: ${e.message}", e))
            return
        }
        armLaunchWatchdog(req)
    }

    /**
     * Amber normally covers Lightning Piggy (pausing it) at once. If we still
     * hold window focus [LAUNCH_WATCHDOG_MS] later with nothing back, Amber
     * never came up. Without focus (e.g. a system dialog) it may still be
     * answering, so check again later. In multi-window both apps can stay
     * resumed and focus moves with the user's taps, so focus proves nothing
     * there; the resume check and stale eviction still apply.
     */
    private fun armLaunchWatchdog(req: PendingRequest) {
        mainHandler.postDelayed({
            if (destroyed || pending !== req || req.leftForeground) return@postDelayed
            val activity = appContext.currentActivity
            val focused = activity?.hasWindowFocus() == true && !activity.isInMultiWindowMode
            if (inForeground && focused) {
                abandon(req, "Amber did not open")
            } else {
                armLaunchWatchdog(req)
            }
        }, LAUNCH_WATCHDOG_MS)
    }
}
