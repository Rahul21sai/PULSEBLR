# PulseBLR Play Console submission truth sheet

This is a Console-owner checklist, not evidence that an account, listing, test, upload, or submission
exists. Re-check every declaration against the deployed build and the current Play Console wording.

## Listing copy

**Short description (ready to copy; 80 characters):**

> Find Bengaluru tech events and keep every connection and follow-up in one place.

**Full description (ready to copy):**

> PulseBLR helps you discover Bengaluru tech events and decide which ones are worth your time. Browse
> upcoming meetups, hackathons, conferences and developer events; open the detail you need; save and
> track the events you care about; and see them in a calendar.
>
> At an event, scan a QR code to capture a connection, keep private notes and follow-up context, and
> show your own code when someone wants your details. Capture is designed to keep working through a
> weak venue connection and sync when you are back online. Use the launcher shortcuts for Scan, My
> code, Feed, Tracker and Calendar, or share an event link to add it to PulseBLR.
>
> Sign in with Google to keep your private tracker and people records scoped to you. Optional email
> reminders and push notifications are controlled in Settings. You can delete your account and its
> associated private data from Settings at any time.

## Console-owned listing fields

- [ ] Set the application name, default language, category, tags, contact details, and public support
  email in Play Console. The support-email value must be the deployed `PULSEBLR_SUPPORT_EMAIL` value;
  do not substitute a guessed address.
- [ ] Enter the privacy-policy URL:
  `https://pulseblr-u9f1.vercel.app/privacy`.
- [ ] Enter the account-deletion URL:
  `https://pulseblr-u9f1.vercel.app/delete-account`.
- [ ] Upload and preview the checked-in assets below in the current Console slots; confirm their
  rendered text and crops before saving.

| Asset | Path | Dimensions / format |
| --- | --- | --- |
| App icon | `store-assets/icon-512.png` | 512×512 PNG, 32-bit with alpha |
| Feature graphic | `store-assets/feature-graphic.png` | 1024×500 PNG, 24-bit, no alpha |
| Phone: feed | `public/screenshots/feed.png` | 1080×1920 PNG |
| Phone: feed rows | `public/screenshots/feed-rows.png` | 1080×1920 PNG |
| Phone: event | `public/screenshots/event.png` | 1080×1920 PNG |
| Phone: calendar | `public/screenshots/calendar.png` | 1080×1920 PNG |
| Phone: topics | `public/screenshots/topics.png` | 1080×1920 PNG |
| Wide: feed | `public/screenshots/wide-feed.png` | 1920×1080 PNG |

## Data Safety inventory to reconcile in Console

The product behavior below is the implementation inventory. Each corresponding Console answer is
owner-owned: choose collection, sharing, purpose, optionality, retention, deletion, and security
answers from the deployed behavior—not from generic boilerplate.

| Data / handling | Implemented purpose and boundary | Console action |
| --- | --- | --- |
| Google profile data: name, email, profile image, Google account identifier | Google OAuth sign-in and account recognition; PulseBLR never receives a Google password. | - [ ] Declare the applicable personal-info/account categories and authentication/account-management purpose. |
| Event data | Public listings are collected from public sources; signed-in people can save, track, or privately add events. | - [ ] Declare the applicable app-activity/content categories, distinguishing public listings from user-owned tracker data. |
| Contacts and scans | QR is decoded in the browser; PulseBLR stores only contact details a person chooses to save, plus optional LinkedIn URL and private context. No continuous camera recording is stored. | - [ ] Declare the applicable personal-info/contact category, collection purpose, and user controls. |
| Private notes and people/follow-up records | Notes, folder names, follow-up dates, application links, tracker data, and interaction history support the signed-in user's private organiser. | - [ ] Declare applicable personal-info/user-content categories and account-management/functionality purposes. |
| Capability tokens | Card, calendar, intake, MCP, and related tokens are private capability-like credentials; deletion revokes owned records. | - [ ] Reconcile these credentials with the Console's authentication/security data categories and deletion answers. |
| Push endpoints | A browser/device push endpoint is stored only when notifications are enabled; browser push providers process the endpoint and notification. | - [ ] Declare the applicable device/identifier category, functionality purpose, optionality, and third-party processing. |
| Email delivery | If email is enabled, Resend processes the delivery address and message needed for digest/reminder delivery. | - [ ] Declare the email/personal-info category, optional communications purpose, and service-provider processing. |
| NVIDIA NIM processing | Configured public event-listing classification and tagging may be processed by NVIDIA NIM. It is not the path for private scanned contacts or private notes. | - [ ] Declare this public-listing processing and any applicable sharing/service-provider answer accurately. |

- [ ] Confirm the deployed `/privacy` and `/delete-account` pages still describe these categories,
  service providers, retention limits, and deletion exceptions (already-delivered email and imported
  calendar copies cannot be recalled by PulseBLR).
- [ ] Confirm Console answers for encryption in transit, account deletion, and any data sharing only
  after reviewing the deployed infrastructure and current Console definitions.

## App access, content, ads, and audience

- [ ] In **App access**, state that private Tracker, People, Scanner, Card, Calendar, and Settings
  flows require Google sign-in. Provide a reviewer-ready Google test account and the exact sign-in
  instructions only through the approved Console channel; do not put credentials in this repository.
- [ ] Explain that public browsing can be reviewed without sign-in where available, while the test
  account is required to verify owner-scoped records, account deletion, notifications, and scans.
- [ ] Complete the **Content rating** questionnaire from the live app. Do not infer answers for
  violence, sexual content, gambling, controlled substances, user-generated content, or other
  current prompts; answer each from actual functionality and moderation behavior.
- [ ] Complete **Target audience and content** with the intended audience, age groups, and any
  required policy declarations. Do not claim child-directed status or an audience not approved by
  the product owner.
- [ ] Review the deployed build for ads. The repository contains no advertising SDK or ad placement;
  select the Console ads answer only after confirming the release has not added one.

## Testing and release controls

- [ ] Complete developer identity verification, application creation, Play App Signing enrollment,
  support contact, and all current Console declarations with the account owner.
- [ ] Upload a protected-workflow signed AAB to **Internal Testing** only after Rahul's explicit
  approval. Install it from Play before treating the build as valid.
- [ ] Confirm the protected `ANDROID_UPLOAD_SHA256` environment variable exactly matches the
  normalized `PB_UPLOAD_SHA256` value used for Digital Asset Links before dispatching the signed
  workflow; both the selected alias and final AAB signer must pass that identity gate.
- [ ] If this is a qualifying new personal developer account, start and maintain the required closed
  test: 12 testers continuously opted in for 14 days. An opt-out resets that tester's clock.
- [ ] Retrieve the Play App Signing SHA-256 fingerprint after Internal Testing; add it alongside the
  upload certificate via `npx tsx scripts/generate-assetlinks.ts --write`, deploy the DAL file, then
  run `npx tsx scripts/diag-assetlinks.ts`. Do not commit a fingerprint invented for testing.
- [ ] Complete production submission and review only after all declaration, test, and device gates
  below are evidenced.

## Play-installed real-device acceptance

All items require the Play-installed build, unless a line explicitly says otherwise.

- [ ] No browser URL bar: the installed app verifies Digital Asset Links for the permanent origin.
- [ ] Google sign-in and sign-out complete end to end.
- [ ] Feed, event detail, tracker, calendar, scan, card, and Settings flows work.
- [ ] Share-target event import works and all five launcher shortcuts open their intended routes.
- [ ] Camera permission and QR capture work.
- [ ] Offline cold start works and queued captures recover/sync when connectivity returns.
- [ ] Push permission and delivery work when configured.
- [ ] Icon, splash, warm theme, and back-navigation behavior are correct.
- [ ] Account deletion removes the account's local/server-owned data, local cleanup happens, and the
  signed-out public deletion page remains reachable.
