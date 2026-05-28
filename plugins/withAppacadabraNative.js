const { withAndroidManifest, withDangerousMod, withPlugins, withMainApplication, withEntitlementsPlist } = require('@expo/config-plugins');
const fs = require('fs-extra');
const path = require('path');

const withRunnerActivityManifest = (config) => {
    return withAndroidManifest(config, async (config) => {
        const androidManifest = config.modResults;
        const mainApplication = androidManifest.manifest.application[0];

        // Check if RunnerActivity is already defined
        const hasRunner = mainApplication.activity?.some(
            (activity) => activity.$['android:name'] === '.RunnerActivity'
        );

        if (!hasRunner) {
            mainApplication.activity.push({
                $: {
                    'android:name': '.RunnerActivity',
                    'android:taskAffinity': '.runner_task',
                    'android:launchMode': 'singleTop',
                    'android:documentLaunchMode': 'intoExisting',
                    'android:theme': '@style/Theme.App.SplashScreen',
                    'android:exported': 'true',
                },
                'intent-filter': [
                    {
                        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
                        category: [
                            { $: { 'android:name': 'android.intent.category.DEFAULT' } },
                            { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
                        ],
                        data: [{ $: { 'android:scheme': 'runapp' } }],
                    },
                ],
            });
        }

        // Opt UCropActivity out of Android 15+ forced edge-to-edge
        const hasUCrop = mainApplication.activity?.some(
            (activity) => activity.$['android:name'] === 'com.yalantis.ucrop.UCropActivity'
        );

        if (!hasUCrop) {
            mainApplication.activity.push({
                $: {
                    'android:name': 'com.yalantis.ucrop.UCropActivity',
                    'android:theme': '@style/UCropOptOut',
                },
            });
        }

        return config;
    });
};

const withUCropTheme = (config) => {
    return withDangerousMod(config, [
        'android',
        async (config) => {
            const projectRoot = config.modRequest.projectRoot;
            const valuesPath = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'values');

            await fs.ensureDir(valuesPath);

            const themeXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="UCropOptOut" parent="Theme.AppCompat.Light.NoActionBar">
        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
    </style>
</resources>
`;
            await fs.writeFile(path.join(valuesPath, 'ucrop_theme.xml'), themeXml, 'utf8');
            console.log('✅ Written ucrop_theme.xml');

            return config;
        },
    ]);
};

const withNativeFiles = (config) => {
    return withDangerousMod(config, [
        'android',
        async (config) => {
            const projectRoot = config.modRequest.projectRoot;
            const androidAppPath = path.join(projectRoot, 'android', 'app');

            // Source paths (native-assets)
            const assetRoot = path.join(projectRoot, 'native-assets');

            // Destination paths
            const packagePath = path.join(androidAppPath, 'src', 'main', 'java', 'ai', 'appacadabra', 'app');
            const resXmlPath = path.join(androidAppPath, 'src', 'main', 'res', 'xml');

            // Ensure dest dirs exist
            await fs.ensureDir(packagePath);
            await fs.ensureDir(resXmlPath);

            // Files to copy
            const filesToCopy = [
                { src: 'RunnerActivity.kt', dest: 'RunnerActivity.kt' },
                { src: 'SharingShortcutsModule.kt', dest: 'SharingShortcutsModule.kt' },
                { src: 'SharingShortcutsPackage.kt', dest: 'SharingShortcutsPackage.kt' },
            ];

            for (const file of filesToCopy) {
                try {
                    const srcPath = path.join(assetRoot, 'android', 'app', 'src', 'main', 'java', 'ai', 'appacadabra', 'app', file.src);
                    // Note: Adjust srcPath if your native-assets structure is flat or deep. 
                    // Using deep structure based on previous copy commands: native-assets/android/app/src/main/java...

                    const destPath = path.join(packagePath, file.dest);
                    if (fs.existsSync(srcPath)) {
                        await fs.copy(srcPath, destPath);
                        console.log(`✅ Copied ${file.src}`);
                    } else {
                        console.warn(`⚠️ ${file.src} not found in native-assets at ${srcPath}`);
                    }
                } catch (e) {
                    console.error(`Error copying ${file.src}:`, e);
                }
            }

            // Copy shortcuts.xml
            try {
                const shortcutsSrc = path.join(assetRoot, 'android', 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
                const destPath = path.join(resXmlPath, 'shortcuts.xml');
                if (fs.existsSync(shortcutsSrc)) {
                    await fs.copy(shortcutsSrc, destPath);
                    console.log('✅ Copied shortcuts.xml');
                } else {
                    console.warn('⚠️ shortcuts.xml not found in native-assets');
                }
            } catch (e) {
                console.error('Error copying shortcuts.xml:', e);
            }

            return config;
        },
    ]);
};

// Inject SharingShortcutsPackage into MainApplication.kt
const withMainApplicationPackageInjection = (config) => {
    return withMainApplication(config, async (config) => {
        let contents = config.modResults.contents;
        const packageImport = 'add(SharingShortcutsPackage())';

        if (!contents.includes(packageImport)) {
            // Look for the PackageList(this).packages.apply { block
            // and inject the add() call
            if (contents.includes('PackageList(this).packages.apply {')) {
                contents = contents.replace(
                    'PackageList(this).packages.apply {',
                    `PackageList(this).packages.apply {\n              add(SharingShortcutsPackage())`
                );
                console.log('✅ Injected SharingShortcutsPackage into MainApplication.kt');
            } else {
                console.warn('⚠️ Could not find PackageList block in MainApplication.kt');
            }
        }
        config.modResults.contents = contents;
        return config;
    });
};

const withIOSEntitlements = (config) => {
    return withEntitlementsPlist(config, (config) => {
        config.modResults['com.apple.developer.healthkit'] = true;
        config.modResults['com.apple.developer.healthkit.access'] = [];
        config.modResults['com.apple.security.application-groups'] = ['group.ai.appacadabra.app'];
        return config;
    });
};

const withAppacadabraNative = (config) => {
    return withPlugins(config, [
        withRunnerActivityManifest,
        withUCropTheme,
        withNativeFiles,
        withMainApplicationPackageInjection,
        withIOSEntitlements,
    ]);
};

module.exports = withAppacadabraNative;
