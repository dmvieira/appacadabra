# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# React Native Firebase
-keep class io.invertase.firebase.** { *; }
-dontwarn io.invertase.firebase.**
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.**
-keep class io.invertase.firebase.app.ReactNativeFirebaseAppModule { *; }
-keep class io.invertase.firebase.auth.ReactNativeFirebaseAuthModule { *; }
-keep class io.invertase.firebase.appcheck.ReactNativeFirebaseAppCheckModule { *; }
-keep class io.invertase.firebase.crashlytics.** { *; }
-keep class com.google.firebase.crashlytics.** { *; }
