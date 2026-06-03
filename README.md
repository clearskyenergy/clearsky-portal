# ClearSky Portal

## Setup Instructions

### 1. Firebase Setup
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project named `clearsky-portal`
3. Enable **Authentication** → Sign-in methods → **Google** (restrict to clearsky-usa.com domain)
4. Enable **Firestore Database** (start in production mode)
5. Copy your Firebase config from Project Settings → Your apps → Web app

### 2. Google Maps API Key
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Enable: Maps JavaScript API, Places API, Geocoding API
3. Create an API key (restrict to your vercel domain)

### 3. Configure the portal
Edit `public/config.js` and fill in your keys:
```js
window.CLEARSKY_CONFIG = {
  firebase: {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
  },
  googleMapsKey: "YOUR_MAPS_API_KEY",
  allowedDomain: "clearsky-usa.com"
};
```

### 4. Firebase Security Rules
In Firestore, set these rules:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{projectId} {
      allow read, write: if request.auth != null 
        && request.auth.token.email.matches('.*@clearsky-usa\\.com');
    }
  }
}
```

### 5. Deploy to Vercel
```bash
git init
git add .
git commit -m "Initial ClearSky Portal"
# Push to GitHub, then import in Vercel dashboard
```

## Features
- 🔐 Google OAuth login (restricted to @clearsky-usa.com)
- 💾 Project save/load via Firebase Firestore
- 🗺️ Live Google Maps satellite imagery
- 🔋 BESS Wizard with drag-and-drop assembly
- ⚡ Auto conduit mapping between components
- 🔄 Resize & rotate all components
- 💬 Draggable callout arrows
- 📋 Export to JSON / Proposal Generator
