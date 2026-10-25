# Swift Setup Instructions

## Prerequisites

- Android device with Android 6.0 (API level 23) or higher
- Active SIM card with SMS capability
- Android Studio (for building from source)
- USB debugging enabled (for installation)

## Installation

### Option 1: Install APK (Recommended)

1. Download the latest APK from the releases page
2. Enable "Install from unknown sources" in Android settings
3. Install the APK on your Android device
4. Grant all required permissions when prompted

### Option 2: Build from Source

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd sms-gateway
   ```

2. Open the project in Android Studio

3. Build and install:
   ```bash
   ./gradlew installDebug
   ```

## Initial Setup

### 1. Grant Permissions

When you first open the app, you'll be prompted to grant the following permissions:

- **SMS Permissions**: Required to send SMS messages
  - Send SMS
  - Read SMS
  - Receive SMS
- **Contacts Permission**: Optional, for contact management
- **Network Permissions**: Automatically granted for API server

**Important**: All SMS permissions are required for the app to function properly.

### 2. Configure API Server

1. Open the Swift app
2. The app will automatically generate an API key
3. Configure the server port (default: 8080)
4. Enable the API server by toggling the switch

### 3. Network Configuration

#### Find Your Device IP Address

1. Go to Android Settings > Wi-Fi
2. Tap on your connected network
3. Note the IP address (e.g., 192.168.1.100)

#### Configure Firewall (if needed)

If you're having connection issues, ensure that the port is not blocked by:
- Router firewall
- Network security software
- Corporate network restrictions

## Configuration Options

### API Key Management

- **View API Key**: Tap on the API key text in the main screen
- **Generate New Key**: Use the "Generate New" button in the API key dialog
- **Copy API Key**: Select and copy the key for use in your applications

### Server Settings

- **Port Configuration**: Tap on the port text to change the server port
- **Valid Port Range**: 1024-65535
- **Default Port**: 8080

### Rate Limiting

The app includes built-in rate limiting:
- **Default Limits**: 10 requests/minute, 100 requests/hour
- **Purpose**: Prevents abuse and protects your SMS balance
- **Customization**: Limits can be adjusted in the app settings

## Testing the Installation

### 1. Test API Server

Open a web browser and navigate to:
```
http://<device-ip>:<port>/api/info
```

Example: `http://192.168.1.100:8080/api/info`

You should see a JSON response with API information.

### 2. Test SMS Sending

#### Using the App Interface

1. Tap the floating action button (envelope icon)
2. Enter a phone number and message
3. Tap "Send"
4. Check the SMS history for delivery status

#### Using the API

```bash
curl -X POST http://192.168.1.100:8080/api/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "phone_number": "+1234567890",
    "message": "Test message from SMS Gateway"
  }'
```

## Troubleshooting

### Common Issues

#### 1. App Crashes on Startup
- **Cause**: Missing permissions
- **Solution**: Manually grant SMS permissions in Android Settings > Apps > Swift > Permissions

#### 2. API Server Won't Start
- **Cause**: Port already in use
- **Solution**: Change the port number in app settings

#### 3. SMS Not Sending
- **Causes**: 
  - No SIM card or inactive SIM
  - Insufficient SMS balance
  - Network connectivity issues
  - Missing SMS permissions
- **Solutions**:
  - Check SIM card status
  - Verify SMS balance with carrier
  - Check network connectivity
  - Re-grant SMS permissions

#### 4. Cannot Connect to API
- **Causes**:
  - Wrong IP address or port
  - Firewall blocking connections
  - Device not on same network
- **Solutions**:
  - Verify device IP address
  - Check firewall settings
  - Ensure devices are on same network

#### 5. Authentication Errors
- **Cause**: Invalid or missing API key
- **Solution**: Copy the correct API key from the app

### Logs and Debugging

#### View App Logs
```bash
adb logcat | grep "SMS"
```

#### Check Server Status
The app displays server status in the main interface:
- "Server Status: Running on port XXXX" - Server is active
- "Server Status: Stopped" - Server is not running

## Security Considerations

### Network Security

1. **Local Network Only**: By default, the API server only accepts connections from the local network
2. **API Key Protection**: Keep your API key secure and don't share it publicly
3. **HTTPS**: Consider using a reverse proxy with HTTPS for production use

### SMS Security

1. **Rate Limiting**: Built-in rate limiting prevents abuse
2. **Message Validation**: All messages are validated before sending
3. **Audit Trail**: Complete SMS history is maintained

### Device Security

1. **Screen Lock**: Use a screen lock to protect device access
2. **App Permissions**: Regularly review granted permissions
3. **Updates**: Keep the app updated for security patches

## Advanced Configuration

### Custom Port Configuration

1. Tap on the port text in the main screen
2. Enter a port number between 1024-65535
3. Restart the server if it's currently running

### Backup and Restore

#### Export Configuration
The app automatically saves configuration in Android's shared preferences.

#### Manual Backup
1. Use Android's built-in backup feature
2. Or manually note down your API key and settings

## Network Requirements

### Minimum Requirements
- Wi-Fi or mobile data connection
- Local network access for API clients

### Recommended Setup
- Stable Wi-Fi connection
- Static IP address (or DHCP reservation)
- Unrestricted network access

## Performance Considerations

### SMS Throughput
- **Single SMS**: ~1-2 seconds per message
- **Bulk SMS**: Processed sequentially
- **Carrier Limits**: Respect carrier SMS limits

### Resource Usage
- **RAM**: ~50-100 MB
- **Storage**: ~20 MB app + SMS history
- **Battery**: Minimal impact when idle

## Support

For issues and questions:
1. Check the troubleshooting section above
2. Review the API documentation
3. Check device logs for error messages
4. Ensure all permissions are granted

---

## Push Wake Configuration (Firebase Cloud Messaging)

For real-time SMS wake signals (Phase 2), configure Firebase Admin credentials in the backend environment:

1. **Create Firebase Project**: Navigate to the [Firebase Console](https://console.firebase.google.com/) and create a project.
2. **Generate Service Account**:
   - Go to **Project Settings** > **Service accounts**.
   - Select Node.js and click **Generate new private key**.
   - Download the JSON credentials file securely (never commit this file to git).
3. **Configure Environment Variables**:
   In your Vercel deployment or local `.env.local`:
   ```bash
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
   ```
   *Note: Escaped newlines (`\n`) in `FIREBASE_PRIVATE_KEY` are automatically resolved at runtime.*
4. **Fallback Handling**: If Firebase credentials are not set on the backend, Swift records a sanitized outbox failure and leaves all SMS jobs safely queued in PostgreSQL, where Android gateways retrieve them via WorkManager 15-minute recovery or manual "Sync Now".

### Android Gateway Firebase Client Setup (Human Operator Step)

To enable live FCM push wake-up on Android devices (Phase 3):

1. **Add Android App in Firebase Console:**
   - In your Firebase Console, click **Add app** > **Android**.
   - Android package name: `com.multi.encription.sms` (must match application ID exactly).
   - App nickname (optional): `Swift Gateway Android`.
   - Debug signing certificate SHA-1 (optional for basic FCM data messaging).
2. **Download Configuration File:**
   - Download the generated `google-services.json`.
3. **Place in Project:**
   - Copy `google-services.json` into the `app/` directory:
     ```text
     SMS-Gateway-Free/
       app/
         google-services.json  <-- Place file here
         build.gradle.kts
         src/
     ```
   - **Security Note:** `app/google-services.json` is listed in `.gitignore`. **NEVER** commit this file or service account credentials to version control.
4. **Build Flexibility (Offline / CI-Friendly):**
   - The Gradle build configuration automatically detects whether `app/google-services.json` is present. If missing, `processDebugGoogleServices` is skipped safely, allowing compilation, static analysis, and unit test suites to pass in clean CI/development environments without dummy credentials.
5. **Verify Live Push Wakeup on Device:**
   - Launch the app with Gateway Key configured in **GLOBAL_WORKER** mode.
   - The app retrieves its FCM registration token and registers it via `PUT /api/v1/gateway/push-token`.
   - When an OTP is initiated from any project, the backend writes to `notification_outbox` and sends an FCM push (`data.type = "JOBS_AVAILABLE"`).
   - Logcat verification:
     ```text
     GatewayFirebaseMessaging: Received push message (data payload: {type=JOBS_AVAILABLE})
     JobDrainEngine: Draining queue triggered by FCM_PUSH
     GlobalGatewayWorker: SMS job claimed and dispatched successfully
     ```

### Phase 4 Outbox Retry Scheduler

Immediate FCM delivery is attempted when an OTP is queued. To retry failed wakes and reclaim interrupted outbox leases, configure a trusted scheduler that can make an authenticated `POST` request:

1. Generate a high-entropy secret (at least 32 random bytes) and configure it only in the backend and scheduler environments:
   ```bash
   OUTBOX_SCHEDULER_SECRET=replace-with-a-long-random-secret
   ```
2. Invoke `POST /api/v1/internal/outbox/dispatch` with `Authorization: Bearer <OUTBOX_SCHEDULER_SECRET>` and an optional JSON body such as `{ "batch_size": 25, "max_time_ms": 10000 }`.
3. Never place the scheduler secret in a URL or client application. The endpoint rejects query-string credentials.
4. No scheduler is installed automatically by this repository. Until a trusted scheduler is configured, immediate FCM delivery and Android's 15-minute WorkManager reconciliation remain available, but server-side outbox retries will not run automatically.
