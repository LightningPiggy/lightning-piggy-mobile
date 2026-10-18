package com.lightningpiggy.documentmetadata

import android.net.Uri
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import java.io.File
import android.provider.OpenableColumns
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Resolve a selected document's name without deriving it from an opaque URI. */
class DocumentMetadataModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DocumentMetadata")

    AsyncFunction("renderPdfFirstPageAsync") { fileUri: String, maxWidthPx: Int ->
      try {
        val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
        val uri = Uri.parse(fileUri)
        require(uri.scheme == "file")
        val source = File(requireNotNull(uri.path)).canonicalFile
        require(source.path.startsWith(context.cacheDir.canonicalPath + File.separator))
        require(source.length() in 1..10L * 1024 * 1024)
        val width = maxWidthPx.coerceIn(1, 1200)
        val target = File(source.parentFile, source.name + ".preview-$width.png")
        if (!target.exists()) {
          ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
            PdfRenderer(descriptor).use { renderer ->
              renderer.openPage(0).use { page ->
                val height = (width.toDouble() * page.height / page.width).toInt().coerceIn(1, 2400)
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                try {
                  bitmap.eraseColor(Color.WHITE)
                  page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                  val temporary = File.createTempFile(target.name, ".tmp", target.parentFile)
                  try {
                    temporary.outputStream().use {
                      check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                    }
                    check(temporary.renameTo(target))
                  } finally { temporary.delete() }
                } finally { bitmap.recycle() }
              }
            }
          }
        }
        Uri.fromFile(target).toString()
      } catch (_: Exception) { null }
    }

    AsyncFunction("displayNameAsync") { uriString: String ->
      val uri = Uri.parse(uriString)
      require(uri.scheme == "content") { "Expected a document content URI" }
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      context.contentResolver.query(
        uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null
      )?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
      }
    }
  }
}
