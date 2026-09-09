#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>

// Runs the public updater against an isolated, signed fixture app. No production
// app, signing key, or installation is used by this integration harness.
static NSString *feedURL;
static void (^cancelDownload)(void);
static NSUInteger downloadCount;
static void Event(NSString *event) { fprintf(stdout, "%s\n", event.UTF8String); fflush(stdout); }

@interface HarnessDelegate : NSObject <SPUUpdaterDelegate>
@end
@implementation HarnessDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return feedURL; }
- (void)updater:(SPUUpdater *)updater willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request {
    downloadCount++;
    Event([@"download " stringByAppendingString:request.URL.lastPathComponent]);
}
@end

@interface HarnessDriver : NSObject <SPUUserDriver>
@end
@implementation HarnessDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation { Event(@"checking"); }
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    Event([@"found " stringByAppendingString:item.versionString]);
    reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { Event(error.description); exit(3); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { Event(error.description); exit(2); }
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { cancelDownload = [cancellation copy]; Event(@"download-start"); }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { Event([NSString stringWithFormat:@"total %llu", length]); }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
    if (getenv("CHAIN_CANCEL_SECOND") != NULL && downloadCount == 2 && cancelDownload != nil) {
        void (^cancel)(void) = cancelDownload;
        cancelDownload = nil;
        Event(@"cancelled");
        cancel();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
    }
}
- (void)showDownloadDidStartExtractingUpdate { Event(@"extracting"); }
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    Event(@"ready");
    reply(SPUUserUpdateChoiceInstall);
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry { Event(@"installing"); }
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
    Event(@"installed");
    acknowledgement();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
}
- (void)dismissUpdateInstallation {}
- (void)showUpdateInFocus {}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 64;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSBundle *host = [NSBundle bundleWithPath:@(argv[1])];
        feedURL = @(argv[2]);
        HarnessDriver *driver = [HarnessDriver new];
        HarnessDelegate *delegate = [HarnessDelegate new];
        SPUUpdater *updater = [[SPUUpdater alloc] initWithHostBundle:host applicationBundle:host userDriver:driver delegate:delegate];
        NSError *error = nil;
        if (![updater startUpdater:&error]) { Event(error.description); return 1; }
        dispatch_async(dispatch_get_main_queue(), ^{ [updater checkForUpdates]; });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ Event(@"timeout"); exit(124); });
        [NSApp run];
    }
    return 0;
}
