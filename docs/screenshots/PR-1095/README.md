# Configurable swap backend screenshots

Captured on 18 September 2026 from PR #1095 commit `58f60e652d62aebab95a11676df81032d892d30f`, using an Android API 34 emulator. The installed development client loaded Metro from a separate checkout of that exact commit.

- `01-default-backend.png`: Account → On-chain, showing the default Boltz API URL and the new controls.
- `03-https-validation.png`: Attempting to save an HTTP URL produces the HTTPS validation error before making a network request.

These are unedited emulator captures. Only reserved `example.com` addresses are used for the custom URL; no family endpoint or wallet credentials are displayed. The input was reset to the default after capture. No swap was created and no funds were moved for these two settings captures.

## Live Bitcoin-to-Lightning swap — 20 September 2026

`05-submarine-result.png` is an unedited ADB capture from the same Lightning Piggy emulator, running the PR checkout with the backend-minimum fix from `de643f71`. It shows the 10,000-sat payment received and Coinos test balance increasing from 15,000 to 25,000 sats.

The app funded a 10,201-sat Bitcoin lockup for the 10,000-sat Lightning invoice. After confirmation, the private Boltz backend paid the invoice and reached `transaction.claimed`. No private endpoint or wallet credentials appear in the image.

This proves a live Bitcoin-to-Lightning swap through the configured backend. It does not prove the reverse direction: the earlier 11,000-sat Lightning-to-Bitcoin attempt encountered an upstream Lightning routing failure and remained unpaid. The progress sheet beneath the receipt still contains its earlier handoff text; backend final status and the received payment establish completion.
