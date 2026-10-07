package com.multi.encription.sms.service

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.multi.encription.sms.MainActivity
import com.multi.encription.sms.R
import com.multi.encription.sms.api.SmsApiServer
import com.multi.encription.sms.database.SmsDatabase
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.worker.GlobalGatewayWorker
import kotlinx.coroutines.*
import java.net.NetworkInterface
import java.net.SocketException

class SmsGatewayService : Service() {
    
    private var apiServer: SmsApiServer? = null
    private var globalWorker: GlobalGatewayWorker? = null
    private lateinit var configManager: ConfigManager
    private lateinit var database: SmsDatabase
    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val binder = LocalBinder()
    
    inner class LocalBinder : Binder() {
        fun getService(): SmsGatewayService = this@SmsGatewayService
    }
    
    companion object {
        private const val TAG = "SmsGatewayService"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "sms_gateway_channel"
        
        var instance: SmsGatewayService? = null
            private set
        
        fun startService(context: Context) {
            val intent = Intent(context, SmsGatewayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
        
        fun stopService(context: Context) {
            val intent = Intent(context, SmsGatewayService::class.java)
            context.stopService(intent)
        }
    }
    
    override fun onCreate() {
        super.onCreate()
        instance = this
        configManager = ConfigManager(this)
        database = SmsDatabase.getDatabase(this)
        globalWorker = GlobalGatewayWorker(this, configManager, serviceScope)
        
        createNotificationChannel()
        Log.d(TAG, "Swift Service created (Mode: ${configManager.gatewayMode})")
    }
    
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "Swift Service starting in mode: ${configManager.gatewayMode}")
        
        startForeground(NOTIFICATION_ID, createNotification("Initializing Gateway Service..."))
        
        applyCurrentMode()
        
        // Start cleanup task
        startCleanupTask()
        
        return START_STICKY
    }

    /**
     * Android 15 (API 35) Foreground Service Timeout Callback.
     * When dataSync FGS reaches its cumulative 6-hour runtime limit within a 24-hour window,
     * Android invokes onTimeout(). Calling stopSelf() here prevents the OS from crashing
     * the app process with ForegroundServiceDidNotStopInTimeException.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(
            TAG,
            "Foreground service timed out by Android 15 background policy (fgsType=$fgsType, startId=$startId). " +
            "Gracefully stopping worker to avoid OS termination crash."
        )
        updateNotification("Worker paused by Android 15 background runtime timeout (6h limit). Re-open app to resume.")
        globalWorker?.stop()
        stopSelf(startId)
    }
    
    fun applyCurrentMode() {
        when (configManager.gatewayMode) {
            GatewayMode.LOCAL_API -> {
                globalWorker?.stop()
                if (configManager.isServerEnabled) {
                    startApiServer()
                } else {
                    stopApiServer()
                    updateNotification("Local API Server Stopped")
                }
            }
            GatewayMode.GLOBAL_WORKER -> {
                stopApiServer()
                if (configManager.isWorkerEnabled) {
                    globalWorker?.start()
                    updateNotification("Global OTP Worker: Active & Polling")
                } else {
                    globalWorker?.stop()
                    updateNotification("Global OTP Worker: Paused")
                }
            }
        }
    }
    
    override fun onDestroy() {
        super.onDestroy()
        instance = null
        stopApiServer()
        globalWorker?.stop()
        serviceScope.cancel()
        Log.d(TAG, "Swift Service destroyed")
    }
    
    override fun onBind(intent: Intent?): IBinder = binder
    
    fun getGlobalWorker(): GlobalGatewayWorker? = globalWorker
    
    private fun startApiServer() {
        try {
            if (apiServer?.isAlive == true) {
                Log.d(TAG, "API Server already running")
                return
            }
            
            apiServer = SmsApiServer(this, configManager.serverPort)
            val started = apiServer?.startServer() ?: false
            
            if (started) {
                Log.i(TAG, "API Server started successfully on port ${configManager.serverPort}")
                updateNotification("Local API Server running on port ${configManager.serverPort}")
                logServerUrls()
            } else {
                Log.e(TAG, "Failed to start API Server")
                updateNotification("Failed to start Local API Server")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error starting API Server", e)
            updateNotification("Error starting API Server: ${e.message}")
        }
    }
    
    private fun stopApiServer() {
        try {
            apiServer?.stopServer()
            apiServer = null
            Log.i(TAG, "API Server stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping API Server", e)
        }
    }
    
    private fun logServerUrls() {
        try {
            val port = configManager.serverPort
            val interfaces = NetworkInterface.getNetworkInterfaces()
            
            Log.i(TAG, "Swift API Server URLs:")
            Log.i(TAG, "- Local: http://localhost:$port/api/info")
            Log.i(TAG, "- Local: http://127.0.0.1:$port/api/info")
            
            while (interfaces.hasMoreElements()) {
                val networkInterface = interfaces.nextElement()
                if (!networkInterface.isLoopback && networkInterface.isUp) {
                    val addresses = networkInterface.inetAddresses
                    while (addresses.hasMoreElements()) {
                        val address = addresses.nextElement()
                        if (!address.isLoopbackAddress && address.hostAddress?.contains(':') == false) {
                            Log.i(TAG, "- Network: http://${address.hostAddress}:$port/api/info")
                        }
                    }
                }
            }
            
        } catch (e: SocketException) {
            Log.w(TAG, "Could not enumerate network interfaces", e)
        }
    }
    
    private fun startCleanupTask() {
        if (!configManager.isAutoDeleteOldSmsEnabled) {
            return
        }
        
        serviceScope.launch {
            while (isActive) {
                try {
                    val cutoffTime = System.currentTimeMillis() - (configManager.autoDeleteDays * 24 * 60 * 60 * 1000L)
                    val deletedCount = database.smsDao().run {
                        val oldSmsCount = getSmsCountSince(cutoffTime)
                        deleteOldSms(cutoffTime)
                        oldSmsCount
                    }
                    
                    if (deletedCount > 0) {
                        Log.d(TAG, "Cleaned up $deletedCount old SMS records")
                    }
                    
                } catch (e: Exception) {
                    Log.e(TAG, "Error during cleanup task", e)
                }
                
                // Run cleanup every 24 hours
                delay(24 * 60 * 60 * 1000L)
            }
        }
    }
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Swift Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Swift Worker notifications"
                setShowBadge(false)
            }
            
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }
    
    private fun createNotification(message: String = "Swift Service running"): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Swift")
            .setContentText(message)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .build()
    }
    
    fun updateNotification(message: String) {
        if (configManager.isNotificationEnabled) {
            val notification = createNotification(message)
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.notify(NOTIFICATION_ID, notification)
        }
    }
    
    fun restartApiServer() {
        serviceScope.launch {
            stopApiServer()
            delay(1000)
            if (configManager.isServerEnabled && configManager.gatewayMode == GatewayMode.LOCAL_API) {
                startApiServer()
            }
        }
    }
}
