@echo off
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "ANDROID_HOME=C:\Users\diogo\AppData\Local\Android\Sdk"
cd /d C:\dev\appacadabra\android
call gradlew.bat bundleRelease --console=plain --no-daemon > C:\dev\appacadabra\android\_buildlog_release.txt 2>&1
echo EXITCODE %errorlevel%
