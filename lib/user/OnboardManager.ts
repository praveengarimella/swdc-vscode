import { window, ExtensionContext } from "vscode";
import { serverIsAvailable, getAppJwt } from "../DataController";
import {
    softwareSessionFileExists,
    jwtExists,
    showOfflinePrompt,
    getOsUsername,
    getHostname,
    setItem,
    getItem
} from "../Util";
import { softwarePost, isResponseOk } from "../http/HttpClient";

let secondary_window_activate_counter = 0;
let retry_counter = 0;
// 10 minutes
const check_online_interval_ms = 1000 * 60 * 10;

export async function onboardPlugin(
    ctx: ExtensionContext,
    successFunction: any
) {
    let windowState = window.state;
    // check if window state is focused or not and the
    // secondary_window_activate_counter is equal to zero
    if (!windowState.focused && secondary_window_activate_counter === 0) {
        // This window is not focused, call activate in 1 minute in case
        // there's another vscode editor that is focused. Allow that one
        // to activate right away.
        setTimeout(() => {
            secondary_window_activate_counter++;
            onboardPlugin(ctx, successFunction);
        }, 1000 * 5);
    } else {
        // check session.json existence
        const serverIsOnline = await serverIsAvailable();
        if (!softwareSessionFileExists() || !jwtExists()) {
            // session file doesn't exist
            // check if the server is online before creating the anon user
            if (!serverIsOnline) {
                if (retry_counter === 0) {
                    showOfflinePrompt(true);
                }
                // call activate again later
                setTimeout(() => {
                    retry_counter++;
                    onboardPlugin(ctx, successFunction);
                }, check_online_interval_ms);
            } else {
                // create the anon user
                const result = await createAnonymousUser(serverIsOnline);
                if (!result) {
                    if (retry_counter === 0) {
                        showOfflinePrompt(true);
                    }
                    // call activate again later
                    setTimeout(() => {
                        retry_counter++;
                        onboardPlugin(ctx, successFunction);
                    }, check_online_interval_ms);
                } else {
                    successFunction(ctx, true);
                }
            }
        } else {
            // has a session file, continue with initialization of the plugin
            successFunction(ctx, false);
        }
    }
}

/**
 * create an anonymous user based on github email or mac addr
 */
export async function createAnonymousUser(serverIsOnline) {
    let appJwt = await getAppJwt(serverIsOnline);
    if (appJwt && serverIsOnline) {
        const jwt = getItem("jwt");
        // check one more time before creating the anon user
        if (!jwt) {
            const creation_annotation = "NO_SESSION_FILE";
            const username = await getOsUsername();
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const hostname = await getHostname();
            let resp = await softwarePost(
                "/data/onboard",
                {
                    timezone,
                    username,
                    creation_annotation,
                    hostname
                },
                appJwt
            );
            if (isResponseOk(resp) && resp.data && resp.data.jwt) {
                setItem("jwt", resp.data.jwt);
                return resp.data.jwt;
            }
        }
    }
    return null;
}