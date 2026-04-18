# DigiSmart ERP — Android App (Google Play Store)
# Trusted Web Activity (TWA) Configuration
# =====================================================
# This folder contains everything needed to build
# the Android APK for Google Play Store submission.
# =====================================================

## STEP 1 — What you need (one-time setup)

1. Google Play Developer Account — ₹1,750 one-time fee
   Sign up at: https://play.google.com/console/

2. Your live website URL (after Vercel deployment)
   Example: https://digismart-erp.vercel.app

3. PWABuilder website (free, no coding needed)
   URL: https://www.pwabuilder.com


## STEP 2 — Build APK using PWABuilder (easiest method)

1. Go to https://www.pwabuilder.com
2. Enter your website URL: https://your-domain.com
3. Click "Start" — PWABuilder will analyze your PWA
4. Click "Build My PWA"
5. Select "Android" → click "Generate"
6. Download the APK file (digismart-erp.apk)

That's it! No Android Studio needed.


## STEP 3 — Submit to Google Play Store

1. Go to https://play.google.com/console
2. Create new app → "DigiSmart ERP - School Management"
3. Select category: "Education"
4. Upload your APK / AAB file
5. Fill in app details (see below)
6. Add screenshots (take from phone/browser)
7. Submit for review (takes 2–3 days)


## App Store Listing Details (copy-paste ready)

App Name:
DigiSmart ERP - School Management

Short Description (80 chars):
Complete school management for Tamil Nadu schools

Full Description:
DigiSmart ERP is a complete school management system designed specifically for Tamil Nadu schools — from LKG to Class 12.

KEY FEATURES:
✅ Student Admission & Profiles
✅ Daily Attendance (Face Recognition + Manual)
✅ Fee Collection & Receipts
✅ Exam Management & Report Cards
✅ Staff HR & Salary Management
✅ Transport & GPS Tracking
✅ Parent Communication Portal
✅ Daily Homework for Parents
✅ School Circulars & Announcements
✅ I-Card Generator
✅ Timetable Builder
✅ Billing & Accounts

FOR PARENTS:
- View your child's daily homework
- Receive school circulars and notices
- Fill consent forms online
- See upcoming school events
- Get holiday alerts instantly

FOR SCHOOLS:
- Manage all school operations in one app
- Works on any device — phone, tablet, computer
- Secure cloud storage
- Tamil and English support
- 30-day free trial

Category: Education
Content Rating: Everyone
Price: Free (subscription based)


## STEP 4 — Digital Asset Links (Required for TWA)

After getting your Play Store app package name,
add this file to your website at:
/.well-known/assetlinks.json

{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.digismart.erp",
    "sha256_cert_fingerprints": [
      "YOUR_APP_SIGNING_KEY_FINGERPRINT"
    ]
  }
}

You get the fingerprint from Google Play Console →
App Signing → App signing key certificate.

Create a file at:
digismart-erp/.well-known/assetlinks.json
And paste the above content with your fingerprint.


## STEP 5 — App Icons (required sizes)

Create your app icon in these sizes and save in assets/icons/:
- icon-72.png    (72×72)
- icon-96.png    (96×96)
- icon-128.png   (128×128)
- icon-192.png   (192×192)
- icon-512.png   (512×512)

Use: https://www.pwabuilder.com/imageGenerator
Or:  https://favicon.io/favicon-generator/

Icon design: Square, maroon background (#6B1A1A),
gold "DS" letters, rounded corners


## Parent App — Separate Listing (Optional)

You can also create a separate app for parents:
App Name: DigiSmart ERP - Parent Portal
URL: https://your-domain.com/parent/index.html

This gives parents a separate, simpler app
focused only on homework, notices and events.


## Summary of Files to Deploy

Your Vercel deployment should include:
/manifest.json           ← PWA manifest
/sw.js                   ← Service worker
/parent/index.html       ← Parent login
/parent/dashboard.html   ← Parent dashboard
/.well-known/
  assetlinks.json        ← For TWA verification (add after Play Store)
/assets/icons/
  icon-192.png           ← App icons (create these)
  icon-512.png


## Timeline

Day 1:  Deploy to Vercel with custom domain
Day 1:  Test PWA install on Android phone
Day 2:  Use PWABuilder to generate APK
Day 2:  Create Google Play Developer account (₹1,750)
Day 3:  Submit app to Play Store
Day 5–7: App approved and live on Play Store!
