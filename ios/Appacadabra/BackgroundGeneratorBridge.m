#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exports the Swift `BackgroundGenerator` class (annotated `@objc`) to the
// React Native bridge. The Swift methods use `RCT_EXTERN_METHOD` here rather
// than being auto-discovered so we control the exact bridge signatures — the
// same signatures store.ts on the JS side expects to call.
@interface RCT_EXTERN_MODULE(BackgroundGenerator, RCTEventEmitter)

RCT_EXTERN_METHOD(startCreate:(NSDictionary *)params
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startEdit:(NSDictionary *)params
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(endJob:(NSString *)jobId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancel:(NSString *)jobId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(status:(NSString *)jobId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(scheduleBackgroundProcessing:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Keep-alive for WebView AI calls (AppacadabraAI.* inside a spell). Consumed
// via lib/webviewAiKeepAlive.ts — one acquire per AI call, one release in the
// completion path (success or failure).
RCT_EXTERN_METHOD(acquireKeepAlive:(NSString *)reason
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(releaseKeepAlive:(NSString *)tokenId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
