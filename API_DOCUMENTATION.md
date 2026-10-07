# Swift API Documentation

## Overview

The SMS Gateway API allows you to send SMS messages through an Android device's cellular connection. The API provides RESTful endpoints for sending individual and bulk SMS messages, checking delivery status, and managing SMS history.

## Base URL

```
http://<device-ip>:<port>/api
```

Default port: `8080`

## Authentication

All API endpoints (except `/info`) require authentication using an API key. Include the API key in one of the following ways:

### Header Authentication
```
X-API-Key: your_api_key_here
```

### Bearer Token Authentication
```
Authorization: Bearer your_api_key_here
```

## Endpoints

### 1. Get API Information

**GET** `/api/info`

Returns basic information about the API server.

**Response:**
```json
{
  "app_name": "Swift",
  "version": "1.0.0",
  "status": "active",
  "endpoints": [
    "/api/send",
    "/api/send-bulk",
    "/api/status",
    "/api/history",
    "/api/info"
  ],
  "server_time": 1703123456789
}
```

### 2. Send Single SMS

**POST** `/api/send`

Sends a single SMS message.

**Request Body:**
```json
{
  "phone_number": "+1234567890",
  "message": "Hello, this is a test message!",
  "request_id": "optional-unique-id"
}
```

**Response:**
```json
{
  "success": true,
  "message": "SMS queued for sending",
  "sms_id": 123,
  "request_id": "optional-unique-id",
  "status": "PENDING",
  "timestamp": 1703123456789
}
```

### 3. Send Bulk SMS

**POST** `/api/send-bulk`

Sends multiple SMS messages in a single request.

**Request Body:**
```json
{
  "messages": [
    {
      "phone_number": "+1234567890",
      "message": "Hello User 1!",
      "request_id": "msg-1"
    },
    {
      "phone_number": "+0987654321",
      "message": "Hello User 2!",
      "request_id": "msg-2"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Processed 2 messages: 2 successful, 0 failed",
  "results": [
    {
      "success": true,
      "message": "SMS queued for sending",
      "sms_id": 124,
      "request_id": "msg-1",
      "status": "PENDING"
    },
    {
      "success": true,
      "message": "SMS queued for sending",
      "sms_id": 125,
      "request_id": "msg-2",
      "status": "PENDING"
    }
  ],
  "total_count": 2,
  "success_count": 2,
  "failed_count": 0
}
```

### 4. Check SMS Status

**GET** `/api/status?request_id=<request_id>`
**GET** `/api/status?sms_id=<sms_id>`

Checks the delivery status of an SMS message.

**Response:**
```json
{
  "success": true,
  "sms_id": 123,
  "request_id": "optional-unique-id",
  "phone_number": "+1234567890",
  "message": "Hello, this is a test message!",
  "status": "DELIVERED",
  "timestamp": 1703123456789,
  "delivery_timestamp": 1703123460000,
  "error_message": null
}
```

### 5. Get SMS History

**GET** `/api/history`

Retrieves SMS history with optional filtering and pagination.

**Query Parameters:**
- `limit` (optional): Number of records to return (default: 50, max: 1000)
- `offset` (optional): Number of records to skip (default: 0)
- `status` (optional): Filter by status (PENDING, SENT, DELIVERED, FAILED)
- `phone_number` (optional): Filter by phone number (partial match)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "success": true,
      "sms_id": 123,
      "request_id": "optional-unique-id",
      "phone_number": "+1234567890",
      "message": "Hello, this is a test message!",
      "status": "DELIVERED",
      "timestamp": 1703123456789,
      "delivery_timestamp": 1703123460000,
      "error_message": null
    }
  ],
  "total_count": 1,
  "limit": 50,
  "offset": 0
}
```

### 6. Get Configuration

**GET** `/api/config`

Returns current server configuration (requires authentication).

**Response:**
```json
{
  "success": true,
  "config": {
    "server_port": 8080,
    "server_enabled": true,
    "rate_limit_enabled": true,
    "rate_limit_per_minute": 10,
    "rate_limit_per_hour": 100,
    "notification_enabled": true
  }
}
```

## Status Codes

- `PENDING`: SMS is queued for sending
- `SENT`: SMS has been sent to the carrier
- `DELIVERED`: SMS has been delivered to the recipient
- `FAILED`: SMS sending failed
- `UNKNOWN`: Status is unknown

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error description",
  "error_code": "ERROR_CODE",
  "timestamp": 1703123456789
}
```

### Common Error Codes

- `AUTHENTICATION_FAILED`: Invalid or missing API key
- `INVALID_REQUEST`: Invalid request format or missing required fields
- `INVALID_JSON`: Malformed JSON in request body
- `NOT_FOUND`: Requested resource not found
- `INTERNAL_ERROR`: Server internal error
- `SMS_SEND_FAILED`: Failed to send SMS

## Rate Limiting

The API implements rate limiting to prevent abuse:

- Default: 10 requests per minute, 100 requests per hour
- Rate limits are per API key
- When rate limit is exceeded, the API returns HTTP 429 with error code `RATE_LIMIT_EXCEEDED`

## CORS Support

The API includes CORS headers to allow cross-origin requests from web applications.

## Examples

### cURL Examples

**Send SMS:**
```bash
curl -X POST http://192.168.1.100:8080/api/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "phone_number": "+1234567890",
    "message": "Hello from SMS Gateway!"
  }'
```

**Check Status:**
```bash
curl -X GET "http://192.168.1.100:8080/api/status?sms_id=123" \
  -H "X-API-Key: your_api_key_here"
```

**Get History:**
```bash
curl -X GET "http://192.168.1.100:8080/api/history?limit=10&status=DELIVERED" \
  -H "X-API-Key: your_api_key_here"
```
