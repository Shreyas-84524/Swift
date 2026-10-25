# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ==========================================
# Firebase Cloud Messaging Rules
# ==========================================
-keep public class * extends com.google.firebase.messaging.FirebaseMessagingService {
    public <init>();
}
-keep class com.google.firebase.messaging.** { *; }
-dontwarn com.google.firebase.messaging.**

# ==========================================
# AndroidX WorkManager Rules
# ==========================================
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep class * extends androidx.work.Worker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# ==========================================
# Gson & API Data Models
# ==========================================
-keepattributes Signature
-keepattributes *Annotation*
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class com.multi.encription.sms.models.** { *; }
-keep class com.multi.encription.sms.network.** { *; }
-keep class com.multi.encription.sms.database.** { *; }

# ==========================================
# Security: Strip android.util.Log in release builds
# ==========================================
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
    public static int i(...);
    public static int w(...);
    public static int e(...);
    public static int wtf(...);
}
