# SupportMe — Product Requirements Document (v2)

**Version:** 2.0  
**Date:** April 2026  
**Project:** SupportMe — Creator Tipping & Donation Platform  
**Stack:** Next.js · Stellar SDK · Soroban · PostgreSQL · Prisma

---

# 1. Overview

SupportMe is a decentralized creator monetization platform that enables creators to receive tips, donations, and financial support directly from their fans or communities.

Creators connect their wallet, generate a personalized link, share it publicly, and track all payments received from a dashboard.

Supporters can visit the creator’s page, send a tip, optionally leave a message, and receive confirmation of the transaction.

---

# 2. Product Vision

SupportMe aims to become the simplest way for creators to receive financial support globally using blockchain payments.

The platform focuses on:

- simplicity
- transparency
- fast payments
- direct creator-to-supporter interaction
- shareable monetization links

---

# 3. Goals

- Allow creators to receive tips instantly via wallet payments
- Provide unique shareable donation links
- Enable creators to track earnings in real time
- Support multiple payment currencies
- Build a scalable creator monetization infrastructure

---

# 4. User Roles

## Creator

The individual receiving support.

Examples:

- developer
- content creator
- designer
- educator
- community leader
- student

Creators can:

- connect wallet
- create profile
- generate shareable link
- receive donations
- track payments
- manage profile

---

## Supporter

A fan or community member supporting the creator.

Supporters can:

- visit creator page
- send tip
- leave message
- view confirmation

---

# 5. Core User Flow

## Creator Flow

Connect wallet  
Create profile  
Choose username  
Generate link  
Share link  
Receive tips  
Track payments  

---

## Supporter Flow

Open link  
View creator page  
Enter amount  
Optional message  
Send tip  
Receive confirmation  

---

# 6. Core Features

---

# 6.1 Wallet Connection

Users must be able to connect and disconnect their wallet.

Requirements:

- Detect wallet on page load
- Show "Connect Wallet" button
- Display truncated wallet address after connection
- Allow disconnect
- Handle connection errors

---

# 6.2 Creator Profile

Each creator has a personalized public page.

Route:

/username

Example:

supportme.app/sammie

---

## Profile Components

- avatar
- display name
- bio
- wallet address
- support button
- recent supporters
- donation goal
- social links

---

# 6.3 Unique Shareable Link

Each creator receives a unique link.

Example:

supportme.app/{username}

The link is generated after:

- wallet connection
- username creation

---

# 6.4 Send Tip

Supporters can send a payment to the creator.

Required Inputs:

- amount
- currency
- optional message

---

## Transaction States

idle  
pending  
success  
failed  

---

# 6.5 Tip With Message

Supporters can attach a message to their donation.

Example:

Amount: 5 XLM  

Message:

"Thanks for your work!"

---

# 6.6 Donation Tracking Dashboard

Creators can view all payments received.

Route:

/dashboard

---

## Dashboard Metrics

- total earnings
- number of donations
- unique supporters
- average tip
- largest tip

---

## Dashboard Table

Fields:

- sender address
- amount
- currency
- message
- transaction hash
- date

---

# 6.7 Multiple Currency Support

**Status:** Shipped for XLM, USDC and USDT. Custom tokens and fiat/cross-chain payments are planned.

Supported currencies:

- XLM
- USDC
- USDT
- Custom tokens

Future:

- fiat payments
- cross-chain payments

---

# 6.8 Donation Goal

**Status:** Shipped.

Creators can set a funding goal.

Example:

Goal Title:

Buy a new laptop

Target:

500 XLM

Progress:

72%

---

# 6.9 Recent Supporters Feed

**Status:** Shipped.

Display recent donations.

Example:

Tunde sent 5 XLM  
Ada sent 10 XLM  
John sent 3 XLM  

---

# 6.10 Notifications

**Status:** Partly shipped. Email notices for a received donation and a reached goal are implemented, and in-app toast notifications exist. Large-donation alerts and push notifications are planned (no implementation exists).

Creators receive notifications when:

- a donation is received
- a large donation occurs
- a goal is reached


---

## Notification Channels

- in-app
- email
- push notifications

---

# 6.11 QR Code Generator

**Status:** Shipped.

Automatically generate a QR code for the creator’s page.

Capabilities:

- display QR code
- download QR code
- share QR code

---

# 6.12 Tip Presets

**Status:** Shipped.

Provide quick payment buttons.

Examples:

1 XLM  
5 XLM  
10 XLM  
Custom  

---

# 6.13 Custom Themes

**Status:** Shipped.

Creators can customize their page.

Options:

- background color
- accent color
- font
- layout

---

# 6.14 Leaderboard

**Status:** Shipped.

Display top supporters.

Examples:

Top supporters  
Top creators  
Top communities  

---

# 7. Database Models

---

This section mirrors [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma),
which is the source of truth. If the two disagree, the schema wins.

## User

```
id, walletAddress (unique, nullable), email (unique, nullable),
createdAt, updatedAt, deletedAt (nullable)
```

`walletAddress` is null for magic-link and OAuth accounts until a wallet is
connected. `deletedAt` marks an account anonymized through account deletion.

## OAuthIdentity

```
id, provider, providerAccountId, userId (foreign key),
accessToken (nullable), refreshToken (nullable), createdAt, updatedAt
```

Unique on `(provider, providerAccountId)`.

## MagicLinkToken

```
id, tokenHash (unique), email, userId (nullable foreign key),
expiresAt, usedAt (nullable), createdAt
```


Only the SHA-256 hash of the token is stored.

## AdminAuditLog

```
id, adminId (nullable foreign key), adminWalletAddress, action,
targetType, targetId, before (JSON, nullable), after (JSON, nullable),
requestId (nullable), createdAt
```

## Creator

```
id, userId (foreign key, unique), username (unique), walletAddress (nullable),
displayName, bio, avatarUrl, socialLinks (JSON),
acceptsXlm (default: true), acceptsUsdc (default: true),
acceptsUsdt (default: false),
presetAmounts (Decimal[], default: empty), theme (JSON, nullable),
donationGoal (deprecated, see Goal), createdAt, updatedAt
```

A connected `walletAddress` is unique across creators.

> **Not implemented:** `coverImage`. An earlier version of this document listed a
> cover image on the creator profile, but no such field exists in the schema.

## Donation

```
id, creatorId (foreign key), senderAddress, amount (Decimal),
currency (default: "XLM"), message, transactionHash,

onChainEventId (unique), rpcEventId (unique),
operationIndex (default: 0), eventIndex (default: 0),
verified (default: true), createdAt
```

Unique on `(transactionHash, operationIndex, eventIndex)`.

## DonationIdempotencyKey

```
key (primary key), donationId (foreign key, unique), expiresAt,
createdAt, requestHash (nullable)
```

## Withdrawal

```
id, creatorId (foreign key), amountIn (Decimal), amountOut (Decimal, nullable),
fee (Decimal, nullable), currency (default: "USDC"), anchorTxId,
stellarTxId (nullable), status (default: "completed"),
verified (default: false), createdAt
```

Unique on `(creatorId, anchorTxId)`.

## Goal

```
id, creatorId (foreign key), title, description, targetAmount (Decimal),
currentAmount (Decimal, default: 0), currency (default: "XLM"),
status (ACTIVE | COMPLETED | EXPIRED, default: ACTIVE),
recurring (default: false), recurrenceInterval (WEEKLY | MONTHLY, nullable),

currentPeriodEnd (nullable), createdAt, updatedAt
```

## Subscription

```
id, creatorId (foreign key), supporterAddress, token, amount (Decimal),
intervalSecs, onChainId (unique), subscribeTxHash, nextChargeAt,
active (default: true), lastChargeTxHash, lastChargedAt, lastError,
failureCount (default: 0), failureNotifiedAt, claimedAt, claimedBy,
createdAt, updatedAt
```

## EmailEvent

```
id, recipient, subject, type (SENT | DELIVERED | BOUNCED | COMPLAINED | FAILED),
providerMessageId (nullable), errorDetail (nullable), createdAt
```

## NetworkCheckpoint

```
key (primary key), value, updatedAt
```

Holds operational state that must survive restarts, such as the last Soroban
ledger sequence the backend observed.