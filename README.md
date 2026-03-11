# NostrLiveStream
https://craigthespacebum.github.io/NostrLiveStream/

NostrLiveStream is an experimental **decentralized livestreaming platform built on Nostr**.

It allows creators to stream content while leveraging the **Nostr protocol for identity, chat, discovery, and social interaction**, removing the need for centralized accounts.

The goal of the project is to build a **Twitch-style experience powered entirely by Nostr identities (npub/nsec)**.

---

# Current Working Features

## Core Nostr Integration
- Login using **Nostr keys (nsec / browser extensions)**.
- Profile loading from **Nostr metadata events**.
- Basic **relay connectivity**.
- Viewing Nostr profiles.

## Profiles
- Profile page displaying:
  - Bio
  - Followers
  - Following
  - Post count
  - Stream count
- Video and photo content tabs.
- Ability to view posts from a user.

## Streaming / Theater Mode
- Stream viewing interface.
- Chat window integrated with Nostr events.
- Basic livestream UI layout.

## Social Features
- Follow button (currently unstable).
- Share button (UI present but incomplete).
- Basic chat functionality in livestream chat.

---

# Known Issues

## General
- Search bar currently does **not support hashtag searching**.
- Limited relay connections.
- Past streams remain in the menu and should be removed.
- Settings UI layout needs improvement.

---

# Profile Issues

### Layout
- Profile statistics box does not align properly with the bio section.

### Profile stats should display in this order:

**Top Row**
- Followers
- Following

**Second Row**
- Post Count
- Stream Count

**Bottom Row**
- Time on Nostr
- Total Sats Received

### Additional Profile Issues
- Videos tab and Photos tab should be merged into one **Media** tab.
- Images inside posts are currently **too large**.
- Video URLs inside posts **do not autoplay or render correctly**.
- Follow button functionality is inconsistent.
- Emoji count display should be removed.
- Report button currently does not function.

### Missing Interaction Features
- No **like system** for posts or comments.
- Comments cannot expand into a dedicated view.
- Users cannot easily create a post from their own profile page.

---

# Theater Mode Issues

### Chat
- Viewer count tab ("Viewers 2.1k") should be removed.
- Messages posted in chat appear **multiple times from the same user** (while other clients show it once).
- Chat settings button should be removed.

### Layout
- Ultra-wide monitor support needs fixing.

### Buttons Not Working
The following controls currently do not function correctly:

- Zap
- Follow
- Like
- Report

### Stream Discovery
- **Live Now** functionality is currently broken.

---

# Planned Features

## Search
- Expand search bar to support **hashtags**.

## Relay Improvements
Add more relay connections such as:

- `damus`
- `zap.stream`
- additional high-availability relays

---

## Social Features

### Groups
Ability to create and join **Nostr Groups**.

### Lists
User-created **curated lists of profiles**.

### Feed
A unified **content feed** showing posts from followed users.

---

## Profile Enhancements

### NIP-05 Identity Indicator
Profiles with verified **NIP-05 identifiers** will display:

- A **glowing purple square** instead of the default purple circle.

### Badges
If a user has badges:

- Bio section splits into two panels.
- Badges display in a dedicated area.
- Clicking a badge opens a **popup with full badge details**.

### Profile Posting
If viewing **your own profile**:

- A post composer appears above the posts feed.

---

## Share Improvements

Clicking the **Share button** will open a dialog offering:

- Copy profile URL
- Share as a Nostr post
- Send via social media platforms
  - Facebook
  - Twitter
  - others

---

## Settings Improvements

Settings will be separated into **three distinct sections**:

### 1. Nostr Profile
- Display name
- Bio
- Picture
- NIP-05

### 2. Relays
- Add/remove relays
- Relay status indicators

### 3. Website Settings
- Theme selection
- UI preferences
- Client behavior settings

---

# Development Goals

The long-term goal of **NostrLiveStream** is to provide:

- Fully decentralized livestreaming
- Native Nostr chat
- Lightning zap support
- Identity tied to Nostr keys
- Open and censorship-resistant streaming infrastructure

---

# Status

⚠️ **Project is currently in active development and experimental.**

Expect bugs, missing features, and UI changes as development continues.

Contributions and testing feedback are welcome.
