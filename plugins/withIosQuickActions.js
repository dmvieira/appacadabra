/**
 * withIosQuickActions
 *
 * Injects iOS Quick Action (home-screen long-press menu) handling into the
 * generated `AppDelegate.swift`. Pairs with `modules/shortcuts/ios/ShortcutsModule.swift`,
 * which publishes the `UIApplicationShortcutItem`s via `setDynamicShortcuts`.
 *
 * Flow:
 *   1. User long-presses the Appacadabra icon and taps a spell shortcut.
 *   2. iOS launches (or resumes) the app and delivers a UIApplicationShortcutItem
 *      with userInfo = { "appId": "<spell-id>" }.
 *   3. We translate that into the deep link `appacadabra://runner/<spell-id>` and
 *      hand it to RCTLinkingManager, which Expo Router resolves to `/runner/[id]`.
 *
 * Two delivery paths are handled:
 *   - Warm launch: `application(_:performActionFor:completionHandler:)`
 *     The app is already running; fire the deep link immediately.
 *   - Cold launch: `application(_:didFinishLaunchingWithOptions:)` is called with
 *     `launchOptions[.shortcutItem]`. The RN bridge / Expo Router isn't ready yet,
 *     so we stash the item on `pendingShortcutItem` and fire it from
 *     `applicationDidBecomeActive`, by which time the JS side is mounted and
 *     `Linking.addEventListener('url', ...)` can pick it up. Per Apple docs we
 *     also return `false` from `didFinishLaunchingWithOptions` to suppress the
 *     follow-up `performActionFor` call the system would otherwise make.
 *
 * Idempotency: the injected code is wrapped in
 * `// APPACADABRA_QUICK_ACTIONS_START` / `// APPACADABRA_QUICK_ACTIONS_END`
 * markers, and re-running `expo prebuild` (without --clean) replaces the block
 * rather than duplicating it.
 */

const { withAppDelegate } = require('@expo/config-plugins');

const START_MARKER = '// APPACADABRA_QUICK_ACTIONS_START';
const END_MARKER = '// APPACADABRA_QUICK_ACTIONS_END';

const PROPERTY_BLOCK = `  ${START_MARKER}
  // Cold-launch shortcut deferred until the JS side is mounted (see applicationDidBecomeActive).
  private var pendingShortcutItem: UIApplicationShortcutItem?
  ${END_MARKER}`;

const HANDLER_BLOCK = `  ${START_MARKER}
  // Warm-launch quick action (home-screen long-press while the app is running/backgrounded).
  public override func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let handled = handleAppacadabraShortcut(shortcutItem)
    completionHandler(handled)
  }

  // Fired after the RN bridge is up; drain any cold-launch shortcut here so
  // Expo Router can resolve appacadabra://runner/<id> via Linking.
  public override func applicationDidBecomeActive(_ application: UIApplication) {
    super.applicationDidBecomeActive(application)
    if let item = pendingShortcutItem {
      pendingShortcutItem = nil
      _ = handleAppacadabraShortcut(item)
    }
  }

  @discardableResult
  private func handleAppacadabraShortcut(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
    guard shortcutItem.type == "ai.appacadabra.app.shortcut.run",
          let appId = shortcutItem.userInfo?["appId"] as? String,
          let url = URL(string: "appacadabra://runner/\\(appId)") else {
      return false
    }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
    return true
  }
  ${END_MARKER}`;

const COLD_LAUNCH_HOOK = `    ${START_MARKER}
    // Capture cold-launch shortcut before super; replay from applicationDidBecomeActive.
    if let shortcutItem = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
      pendingShortcutItem = shortcutItem
      _ = super.application(application, didFinishLaunchingWithOptions: launchOptions)
      return false
    }
    ${END_MARKER}`;

function replaceMarkedBlock(source, replacement) {
  const startIdx = source.indexOf(START_MARKER);
  const endIdx = source.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;

  let lineStart = startIdx;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
  let lineEnd = endIdx + END_MARKER.length;
  while (lineEnd < source.length && source[lineEnd] !== '\n') lineEnd++;

  return source.slice(0, lineStart) + replacement + source.slice(lineEnd);
}

/**
 * Strip the pre-existing hand-written `performActionFor` block in the AppDelegate
 * (left over from manual edits before this plugin existed). Detection is loose
 * on purpose: we look for the function signature and remove the enclosing
 * `public override func` ... matching `}` block.
 */
function stripLegacyPerformActionFor(source) {
  const sigIdx = source.indexOf('performActionFor shortcutItem: UIApplicationShortcutItem');
  if (sigIdx === -1) return source;

  const funcKeyword = source.lastIndexOf('public override func', sigIdx);
  if (funcKeyword === -1) return source;

  let blockStart = funcKeyword;
  while (blockStart > 0 && source[blockStart - 1] !== '\n') blockStart--;
  const prevLineStart = source.lastIndexOf('\n', blockStart - 2);
  if (prevLineStart !== -1) {
    const prevLine = source.slice(prevLineStart + 1, blockStart).trim();
    if (prevLine.startsWith('//')) blockStart = prevLineStart + 1;
  }

  const openBrace = source.indexOf('{', sigIdx);
  if (openBrace === -1) return source;
  let depth = 1;
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) return source;

  let blockEnd = i;
  while (blockEnd < source.length && source[blockEnd] !== '\n') blockEnd++;
  if (blockEnd < source.length) blockEnd++;

  return source.slice(0, blockStart) + source.slice(blockEnd);
}

const withIosQuickActions = (config) => {
  return withAppDelegate(config, (innerConfig) => {
    if (innerConfig.modResults.language !== 'swift') {
      console.warn(
        '[withIosQuickActions] Expected Swift AppDelegate; got ' +
          innerConfig.modResults.language +
          '. Skipping.'
      );
      return innerConfig;
    }

    let contents = innerConfig.modResults.contents;
    const alreadyInjected = contents.includes(START_MARKER);

    contents = stripLegacyPerformActionFor(contents);

    // 1. Property: insert after `var reactNativeFactory: RCTReactNativeFactory?`.
    if (alreadyInjected) {
      const replaced = replaceMarkedBlock(contents, PROPERTY_BLOCK);
      if (replaced) contents = replaced;
    } else {
      const propertyAnchor = 'var reactNativeFactory: RCTReactNativeFactory?';
      if (contents.includes(propertyAnchor)) {
        contents = contents.replace(
          propertyAnchor,
          `${propertyAnchor}\n\n${PROPERTY_BLOCK}`
        );
      } else {
        console.warn(
          '[withIosQuickActions] Could not find property anchor; skipping property injection.'
        );
      }
    }

    // 2. Cold-launch hook: insert at the top of didFinishLaunchingWithOptions.
    const coldStart = contents.indexOf(START_MARKER, contents.indexOf('didFinishLaunchingWithOptions'));
    if (coldStart !== -1 && contents.indexOf(END_MARKER, coldStart) !== -1) {
      let lineStart = coldStart;
      while (lineStart > 0 && contents[lineStart - 1] !== '\n') lineStart--;
      const afterStart = contents.indexOf(END_MARKER, coldStart) + END_MARKER.length;
      let lineEnd = afterStart;
      while (lineEnd < contents.length && contents[lineEnd] !== '\n') lineEnd++;
      contents = contents.slice(0, lineStart) + COLD_LAUNCH_HOOK + contents.slice(lineEnd);
    } else {
      const coldAnchor = 'let delegate = ReactNativeDelegate()';
      if (contents.includes(coldAnchor)) {
        contents = contents.replace(
          coldAnchor,
          `${COLD_LAUNCH_HOOK}\n    ${coldAnchor}`
        );
      } else {
        console.warn(
          '[withIosQuickActions] Could not find cold-launch anchor; skipping cold-launch injection.'
        );
      }
    }

    // 3. Handler block: insert before the final `}` of the AppDelegate class.
    if (contents.includes(`${START_MARKER}\n  // Warm-launch`)) {
      const handlerStart = contents.indexOf(`${START_MARKER}\n  // Warm-launch`);
      let lineStart = handlerStart;
      while (lineStart > 0 && contents[lineStart - 1] !== '\n') lineStart--;
      const handlerEnd = contents.indexOf(END_MARKER, handlerStart) + END_MARKER.length;
      let lineEnd = handlerEnd;
      while (lineEnd < contents.length && contents[lineEnd] !== '\n') lineEnd++;
      contents = contents.slice(0, lineStart) + HANDLER_BLOCK + contents.slice(lineEnd);
    } else {
      const tail = 'class ReactNativeDelegate: ExpoReactNativeFactoryDelegate';
      const tailIdx = contents.indexOf(tail);
      if (tailIdx === -1) {
        console.warn(
          '[withIosQuickActions] Could not find class tail anchor; skipping handler injection.'
        );
      } else {
        const closingBrace = contents.lastIndexOf('}', tailIdx);
        if (closingBrace !== -1) {
          contents =
            contents.slice(0, closingBrace) +
            `${HANDLER_BLOCK}\n` +
            contents.slice(closingBrace);
        }
      }
    }

    innerConfig.modResults.contents = contents;
    console.log('[withIosQuickActions] AppDelegate patched for quick actions.');
    return innerConfig;
  });
};

module.exports = withIosQuickActions;
