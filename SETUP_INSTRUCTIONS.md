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
