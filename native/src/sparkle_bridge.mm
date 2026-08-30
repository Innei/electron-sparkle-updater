#import <Foundation/Foundation.h>
#import <Sparkle/Sparkle.h>
#include <atomic>
#include <napi.h>
#include <string>

static Napi::ThreadSafeFunction g_eventTsfn;
static std::atomic<bool> g_hasEventHandler{false};

static void EmitSparkleEvent(NSDictionary *payload) {
  if (!g_hasEventHandler.load() || payload == nil) return;
  if (![NSJSONSerialization isValidJSONObject:payload]) return;

  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (data == nil || data.length == 0) return;

  auto *json = new std::string(static_cast<const char *>(data.bytes), data.length);
  napi_status status = g_eventTsfn.NonBlockingCall(
      json, [](Napi::Env env, Napi::Function jsCallback, std::string *json) {
        Napi::Value parsed = env.Global()
                                 .Get("JSON")
                                 .As<Napi::Object>()
                                 .Get("parse")
                                 .As<Napi::Function>()
                                 .Call({Napi::String::New(env, *json)});
        jsCallback.Call({parsed});
        delete json;
      });
  if (status != napi_ok) delete json;
}

static NSString *ISO8601String(NSDate *date) {
  if (date == nil) return nil;
  static NSISO8601DateFormatter *formatter;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    formatter = [[NSISO8601DateFormatter alloc] init];
  });
  return [formatter stringFromDate:date];
}

@interface SparkleBridgeLogDelegate : NSObject <SPUUpdaterDelegate>
@end

@implementation SparkleBridgeLogDelegate

- (void)updater:(SPUUpdater *)updater
    didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)updateCheck
                                 error:(nullable NSError *)error {
  if (error != nil) {
    NSLog(@"[sparkle-bridge] update cycle finished with error: %@", error);
  } else {
    NSLog(@"[sparkle-bridge] update cycle finished with no error (no update found or update path taken)");
  }
}

- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  NSLog(@"[sparkle-bridge] update check aborted: %@", error);
}

@end

// Electron owns the progress/install UI. This driver auto-replies to Sparkle
// and never presents SPUStandardUserDriver alerts.
@interface SilentUserDriver : NSObject <SPUUserDriver>
@property(nonatomic, copy, nullable) void (^readyToInstallReply)(SPUUserUpdateChoice);
@property(nonatomic, assign) uint64_t expectedContentLength;
@property(nonatomic, assign) uint64_t receivedLength;
@property(nonatomic, assign) BOOL installWhenReady;
@property(nonatomic, copy, nullable) NSString *updateVersion;
@end

@implementation SilentUserDriver

- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request
                              reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:YES sendSystemProfile:NO]);
}

- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  EmitSparkleEvent(@{@"type" : @"checking"});
}

- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)appcastItem
                                 state:(SPUUserUpdateState *)state
                                 reply:(void (^)(SPUUserUpdateChoice))reply {
  if (appcastItem.informationOnlyUpdate) {
    self.installWhenReady = NO;
    EmitSparkleEvent(@{@"type" : @"error", @"message" : @"informational update"});
    reply(SPUUserUpdateChoiceDismiss);
    return;
  }

  NSString *version = appcastItem.displayVersionString.length > 0
                          ? appcastItem.displayVersionString
                          : appcastItem.versionString;
  self.updateVersion = version;

  BOOL alreadyInstalling = state.stage == SPUUserUpdateStageInstalling && !self.installWhenReady;
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"type"] = alreadyInstalling ? @"update-downloaded" : @"update-available";
  if (version.length > 0) payload[@"version"] = version;
  if (appcastItem.title.length > 0) payload[@"releaseName"] = appcastItem.title;
  NSString *releaseDate = ISO8601String(appcastItem.date);
  if (releaseDate.length > 0) payload[@"releaseDate"] = releaseDate;
  if (appcastItem.itemDescription.length > 0) payload[@"releaseNotes"] = appcastItem.itemDescription;
  EmitSparkleEvent(payload);

  if (alreadyInstalling) {
    reply(SPUUserUpdateChoiceDismiss);
    return;
  }
  reply(SPUUserUpdateChoiceInstall);
}

- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {
}

- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
}

- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  self.installWhenReady = NO;
  self.readyToInstallReply = nil;
  EmitSparkleEvent(@{@"type" : @"update-not-available"});
  acknowledgement();
}

- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  self.installWhenReady = NO;
  self.readyToInstallReply = nil;
  NSString *message = error.localizedDescription.length > 0 ? error.localizedDescription : @"sparkle_error";
  EmitSparkleEvent(@{@"type" : @"error", @"message" : message});
  acknowledgement();
}

- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  self.receivedLength = 0;
  self.expectedContentLength = 0;
}

- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)expectedContentLength {
  self.expectedContentLength = expectedContentLength;
}

- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
  self.receivedLength += length;
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"type"] = @"download-progress";
  payload[@"transferred"] = @(self.receivedLength);
  if (self.expectedContentLength > 0) {
    payload[@"total"] = @(self.expectedContentLength);
    double percent =
        MIN(100.0, (double)self.receivedLength / (double)self.expectedContentLength * 100.0);
    payload[@"percent"] = @(percent);
  }
  EmitSparkleEvent(payload);
}

- (void)showDownloadDidStartExtractingUpdate {
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"type"] = @"download-progress";
  payload[@"percent"] = @(100);
  if (self.receivedLength > 0) payload[@"transferred"] = @(self.receivedLength);
  if (self.expectedContentLength > 0) payload[@"total"] = @(self.expectedContentLength);
  EmitSparkleEvent(payload);
}

- (void)showExtractionReceivedProgress:(double)progress {
}

- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  if (self.installWhenReady) {
    self.installWhenReady = NO;
    self.readyToInstallReply = nil;
    reply(SPUUserUpdateChoiceInstall);
    return;
  }

  self.readyToInstallReply = [reply copy];
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"type"] = @"update-downloaded";
  if (self.updateVersion.length > 0) payload[@"version"] = self.updateVersion;
  EmitSparkleEvent(payload);
}

- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)applicationTerminated
                         retryTerminatingApplication:(void (^)(void))retryTerminatingApplication {
}

- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched
                         acknowledgement:(void (^)(void))acknowledgement {
  acknowledgement();
}

- (void)dismissUpdateInstallation {
  self.installWhenReady = NO;
  self.readyToInstallReply = nil;
}

- (void)showUpdateInFocus {
}

@end

namespace {

SPUUpdater *g_updater = nil;
SilentUserDriver *g_userDriver = nil;
SparkleBridgeLogDelegate *g_logDelegate = nil;

NSString *NapiStringToNSString(const Napi::Value &value) {
  if (!value.IsString()) return nil;
  std::string s = value.As<Napi::String>().Utf8Value();
  return [NSString stringWithUTF8String:s.c_str()];
}

Napi::Value Init(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "init(options) requires an options object").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object options = info[0].As<Napi::Object>();
  NSString *appcastUrl = options.Has("appcastUrl") ? NapiStringToNSString(options.Get("appcastUrl")) : nil;
  NSString *publicEdKey = options.Has("publicEdKey") ? NapiStringToNSString(options.Get("publicEdKey")) : nil;

  __block BOOL initialized = NO;

  void (^work)(void) = ^{
    if (g_updater != nil) {
      initialized = YES;
      return;
    }

    @try {
      g_logDelegate = [[SparkleBridgeLogDelegate alloc] init];
      g_userDriver = [[SilentUserDriver alloc] init];
      NSBundle *hostBundle = [NSBundle mainBundle];
      g_updater = [[SPUUpdater alloc] initWithHostBundle:hostBundle
                                       applicationBundle:hostBundle
                                              userDriver:g_userDriver
                                                delegate:g_logDelegate];

      NSString *plistFeedUrl = hostBundle.infoDictionary[@"SUFeedURL"];
      NSString *plistPublicKey = hostBundle.infoDictionary[@"SUPublicEDKey"];

      if (appcastUrl != nil && plistFeedUrl == nil) {
        // Info.plist SUFeedURL is the packaged-build source of truth; -setFeedURL: is a
        // documented (if deprecated) escape hatch for configuring it out-of-plist, which we
        // use only when the plist key is absent (e.g. dev-shell runs against a stub bundle).
        NSURL *url = [NSURL URLWithString:appcastUrl];
        if (url != nil) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
          [g_updater setFeedURL:url];
#pragma clang diagnostic pop
        }
      }

      if (publicEdKey != nil && plistPublicKey == nil) {
        NSLog(
            @"[sparkle-bridge] publicEdKey was supplied but Info.plist has no SUPublicEDKey; "
             "Sparkle has no supported runtime setter for it — the key must be baked into the "
             "signed Info.plist at package time.");
      }

      NSError *startError = nil;
      if (![g_updater startUpdater:&startError]) {
        NSLog(@"[sparkle-bridge] startUpdater failed: %@", startError);
        g_updater = nil;
        g_userDriver = nil;
        g_logDelegate = nil;
        initialized = NO;
        return;
      }

      initialized = YES;
    } @catch (NSException *exception) {
      NSLog(@"[sparkle-bridge] init threw: %@", exception.reason);
      g_updater = nil;
      g_userDriver = nil;
      g_logDelegate = nil;
      initialized = NO;
    }
  };

  if ([NSThread isMainThread]) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }

  return Napi::Boolean::New(env, initialized);
}

void RunOnMain(void (^work)(void)) {
  if ([NSThread isMainThread]) {
    work();
  } else {
    dispatch_async(dispatch_get_main_queue(), work);
  }
}

Napi::Value CheckForUpdates(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  RunOnMain(^{
    if (g_updater == nil) return;
    @try {
      NSLog(@"[sparkle-bridge] checkForUpdates: canCheckForUpdates=%d sessionInProgress=%d",
            g_updater.canCheckForUpdates, g_updater.sessionInProgress);
      [g_updater checkForUpdates];
    } @catch (NSException *exception) {
      NSLog(@"[sparkle-bridge] checkForUpdates threw: %@", exception.reason);
    }
  });
  return env.Undefined();
}

Napi::Value InstallUpdateNow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  RunOnMain(^{
    if (g_updater == nil || g_userDriver == nil) return;
    @try {
      void (^reply)(SPUUserUpdateChoice) = g_userDriver.readyToInstallReply;
      if (reply != nil) {
        g_userDriver.readyToInstallReply = nil;
        g_userDriver.installWhenReady = NO;
        reply(SPUUserUpdateChoiceInstall);
        return;
      }
      g_userDriver.installWhenReady = YES;
      [g_updater checkForUpdates];
    } @catch (NSException *exception) {
      NSLog(@"[sparkle-bridge] installUpdateNow threw: %@", exception.reason);
      if (g_userDriver != nil) g_userDriver.installWhenReady = NO;
    }
  });
  return env.Undefined();
}

Napi::Value SetAutomaticChecks(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsBoolean()) {
    Napi::TypeError::New(env, "setAutomaticChecks(enabled) requires a boolean").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  bool enabled = info[0].As<Napi::Boolean>().Value();

  RunOnMain(^{
    if (g_updater == nil) return;
    @try {
      g_updater.automaticallyChecksForUpdates = enabled;
    } @catch (NSException *exception) {
      NSLog(@"[sparkle-bridge] setAutomaticChecks threw: %@", exception.reason);
    }
  });

  return env.Undefined();
}

Napi::Value SetEventHandler(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "setEventHandler(fn) requires a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (g_hasEventHandler.exchange(false)) {
    g_eventTsfn.Release();
  }

  g_eventTsfn = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "sparkle-events", 0, 1);
  g_hasEventHandler.store(true);
  return env.Undefined();
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "init"), Napi::Function::New(env, Init));
  exports.Set(Napi::String::New(env, "checkForUpdates"), Napi::Function::New(env, CheckForUpdates));
  exports.Set(Napi::String::New(env, "installUpdateNow"), Napi::Function::New(env, InstallUpdateNow));
  exports.Set(Napi::String::New(env, "setAutomaticChecks"), Napi::Function::New(env, SetAutomaticChecks));
  exports.Set(Napi::String::New(env, "setEventHandler"), Napi::Function::New(env, SetEventHandler));
  return exports;
}

}  // namespace

NODE_API_MODULE(sparkle_bridge, InitModule)
