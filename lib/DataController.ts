import { workspace, commands, ConfigurationTarget } from "vscode";

import {
    softwareGet,
    softwarePut,
    isResponseOk,
    isUserDeactivated,
    softwarePost
} from "./HttpClient";
import { fetchDailyKpmSessionInfo } from "./KpmStatsManager";
import {
    getItem,
    setItem,
    getSoftwareDataStoreFile,
    deleteFile,
    nowInSecs,
    getOsUsername,
    cleanSessionInfo,
    getSessionFileCreateTime,
    getOs,
    getVersion,
    getHostname
} from "./Util";
import { updateShowMusicMetrics } from "./MenuManager";
import { PLUGIN_ID } from "./Constants";
const fs = require("fs");

let loggedInCacheState = false;
let initializedPrefs = false;
let cachedJwt = null;

export async function serverIsAvailable() {
    return await softwareGet("/ping", null)
        .then(result => {
            return isResponseOk(result);
        })
        .catch(e => {
            return false;
        });
}

/**
 * send the offline data
 */
export function sendOfflineData() {
    const dataStoreFile = getSoftwareDataStoreFile();
    try {
        if (fs.existsSync(dataStoreFile)) {
            const content = fs.readFileSync(dataStoreFile).toString();
            if (content) {
                console.log(`Code Time: sending batch payloads: ${content}`);
                const payloads = content
                    .split(/\r?\n/)
                    .map(item => {
                        let obj = null;
                        if (item) {
                            try {
                                obj = JSON.parse(item);
                            } catch (e) {
                                //
                            }
                        }
                        if (obj) {
                            return obj;
                        }
                    })
                    .filter(item => item);
                softwarePost("/data/batch", payloads, getItem("jwt")).then(
                    async resp => {
                        if (isResponseOk(resp) || isUserDeactivated(resp)) {
                            const serverAvailablePromise = await serverIsAvailable();
                            if (serverAvailablePromise) {
                                // everything is fine, delete the offline data file
                                deleteFile(getSoftwareDataStoreFile());
                            }
                        }
                    }
                );
            }
        }
    } catch (e) {
        //
    }
}

/**
 * send any music tracks
 */
export function sendMusicData(trackData) {
    // add the "local_start", "start", and "end"
    // POST the kpm to the PluginManager
    return softwarePost("/data/music", trackData, getItem("jwt"))
        .then(resp => {
            if (!isResponseOk(resp)) {
                return { status: "fail" };
            }
            return { status: "ok" };
        })
        .catch(e => {
            return { status: "fail" };
        });
}

/**
 * get the app jwt
 */
export async function getAppJwt(serverIsOnline) {
    if (serverIsOnline) {
        // get the app jwt
        let resp = await softwareGet(
            `/data/apptoken?token=${nowInSecs()}`,
            null
        );
        if (isResponseOk(resp)) {
            return resp.data.jwt;
        }
    }
    return null;
}

/**
 * create an anonymous user based on github email or mac addr
 */
export async function createAnonymousUser(serverIsOnline) {
    let appJwt = await getAppJwt(serverIsOnline);
    if (appJwt && serverIsOnline) {
        let jwt = getItem("jwt");
        // check one more time before creating the anon user
        if (!jwt && !cachedJwt) {
            let creation_annotation = "NO_JWT";
            let username = await getOsUsername();
            let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            let hostname = await getHostname();
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
                cachedJwt = resp.data.jwt;
            }
        } else {
            // something happened that we now have a jwt,
            // just update the jwt to the cached jwt if we have it
            if (!jwt && cachedJwt) {
                setItem("jwt", cachedJwt);
            }
        }
    }
}

async function isLoggedOn(serverIsOnline, jwt) {
    if (serverIsOnline) {
        let api = "/users/plugin/state";
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp) && resp.data) {
            // NOT_FOUND, ANONYMOUS, OK, UNKNOWN
            let state = resp.data.state ? resp.data.state : "UNKNOWN";
            if (state === "OK") {
                let email = resp.data.email;
                setItem("name", email);
                // check the jwt
                let pluginJwt = resp.data.jwt;
                // update the cached jwt
                cachedJwt = pluginJwt;
                if (pluginJwt && pluginJwt !== jwt) {
                    // update it
                    setItem("jwt", pluginJwt);
                    // re-initialize preferences
                    initializedPrefs = false;
                }
                return { loggedOn: true, state };
            }
            // return the state that is returned
            return { loggedOn: false, state };
        }
    }
    return { loggedOn: false, state: "UNKNOWN" };
}

/**
 * check if the user is registered or not
 * return {loggedIn: true|false}
 */
export async function getUserStatus() {
    cleanSessionInfo();

    let jwt = getItem("jwt");

    let serverIsOnline = await serverIsAvailable();
    let loggedIn = false;
    if (serverIsOnline) {
        // if no jwt create an anon user
        if (!jwt && !cachedJwt) {
            // create an anonymous user
            await createAnonymousUser(serverIsOnline);
        }

        // refetch the jwt then check if they're logged on
        jwt = getItem("jwt");
        let loggedInResp = await isLoggedOn(serverIsOnline, jwt);
        if (!loggedInResp.loggedOn && cachedJwt && jwt !== cachedJwt) {
            // not logged in and the jwt doesn't match the jwt, try the cached one
            loggedInResp = await isLoggedOn(serverIsOnline, cachedJwt);
        }
        // set the loggedIn bool value
        loggedIn = loggedInResp.loggedOn;
    }

    if (serverIsOnline && loggedIn && !initializedPrefs) {
        initializePreferences();
        initializedPrefs = true;
    }

    let userStatus = {
        loggedIn
    };

    if (!loggedIn) {
        // make sure we don't show the name in the tooltip if they're not logged in
        setItem("name", null);
    }

    commands.executeCommand(
        "setContext",
        "codetime:loggedIn",
        userStatus.loggedIn
    );

    if (serverIsOnline && loggedInCacheState !== loggedIn) {
        sendHeartbeat(`STATE_CHANGE:LOGGED_IN:${loggedIn}`);
        setTimeout(() => {
            fetchDailyKpmSessionInfo();
        }, 1000);
    }

    loggedInCacheState = loggedIn;

    return userStatus;
}

export async function getUser(serverIsOnline, jwt) {
    if (jwt && serverIsOnline) {
        let api = `/users/me`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (resp && resp.data && resp.data.data) {
                return resp.data.data;
            }
        }
    }
    return null;
}

export async function initializePreferences() {
    let jwt = getItem("jwt");
    let serverIsOnline = await serverIsAvailable();
    if (jwt && serverIsOnline) {
        let user = await getUser(serverIsOnline, jwt);
        if (user && user.preferences) {
            let userId = parseInt(user.id, 10);
            let prefs = user.preferences;
            let prefsShowMusic =
                prefs.showMusic !== null && prefs.showMusic !== undefined
                    ? prefs.showMusic
                    : null;
            let prefsShowGit =
                prefs.showGit !== null && prefs.showGit !== undefined
                    ? prefs.showGit
                    : null;
            let prefsShowRank =
                prefs.showRank !== null && prefs.showRank !== undefined
                    ? prefs.showRank
                    : null;

            if (
                prefsShowMusic === null ||
                prefsShowGit === null ||
                prefsShowRank === null
            ) {
                await sendPreferencesUpdate(userId, prefs);
            } else {
                if (prefsShowMusic !== null) {
                    await workspace
                        .getConfiguration()
                        .update(
                            "showMusicMetrics",
                            prefsShowMusic,
                            ConfigurationTarget.Global
                        );
                    updateShowMusicMetrics(prefsShowMusic);
                }
                if (prefsShowGit !== null) {
                    await workspace
                        .getConfiguration()
                        .update(
                            "showGitMetrics",
                            prefsShowGit,
                            ConfigurationTarget.Global
                        );
                }
                if (prefsShowRank !== null) {
                    await workspace
                        .getConfiguration()
                        .update(
                            "showWeeklyRanking",
                            prefsShowRank,
                            ConfigurationTarget.Global
                        );
                }
            }
        }
    }
}

async function sendPreferencesUpdate(userId, userPrefs) {
    let api = `/users/${userId}`;
    let showMusicMetrics = workspace.getConfiguration().get("showMusicMetrics");
    let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");
    let showWeeklyRanking = workspace
        .getConfiguration()
        .get("showWeeklyRanking");
    userPrefs["showMusic"] = showMusicMetrics;
    userPrefs["showGit"] = showGitMetrics;
    userPrefs["showRank"] = showWeeklyRanking;

    updateShowMusicMetrics(showMusicMetrics);

    // update the preferences
    // /:id/preferences
    api = `/users/${userId}/preferences`;
    let resp = await softwarePut(api, userPrefs, getItem("jwt"));
    if (isResponseOk(resp)) {
        console.log("Code Time: update user code time preferences");
    }
}

export async function updatePreferences() {
    let showMusicMetrics = workspace.getConfiguration().get("showMusicMetrics");
    let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");
    let showWeeklyRanking = workspace
        .getConfiguration()
        .get("showWeeklyRanking");

    updateShowMusicMetrics(showMusicMetrics);

    // get the user's preferences and update them if they don't match what we have
    let jwt = getItem("jwt");
    let serverIsOnline = await serverIsAvailable();
    if (jwt && serverIsOnline) {
        let user = await getUser(serverIsOnline, jwt);
        if (!user) {
            return;
        }
        let api = `/users/${user.id}`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (
                resp &&
                resp.data &&
                resp.data.data &&
                resp.data.data.preferences
            ) {
                let prefs = resp.data.data.preferences;
                let prefsShowMusic =
                    prefs.showMusic !== null && prefs.showMusic !== undefined
                        ? prefs.showMusic
                        : null;
                let prefsShowGit =
                    prefs.showGit !== null && prefs.showGit !== undefined
                        ? prefs.showGit
                        : null;
                let prefsShowRank =
                    prefs.showRank !== null && prefs.showRank !== undefined
                        ? prefs.showRank
                        : null;

                if (
                    prefsShowMusic === null ||
                    prefsShowGit === null ||
                    prefsShowRank === null ||
                    prefsShowMusic !== showMusicMetrics ||
                    prefsShowGit !== showGitMetrics ||
                    prefsShowRank !== showWeeklyRanking
                ) {
                    await sendPreferencesUpdate(parseInt(user.id, 10), prefs);
                }
            }
        }
    }
}

export async function refetchUserStatusLazily(tryCountUntilFoundUser = 3) {
    setTimeout(() => {
        userStatusFetchHandler(tryCountUntilFoundUser);
    }, 10000);
}

async function userStatusFetchHandler(tryCountUntilFoundUser) {
    let userStatus = await getUserStatus();
    if (!userStatus.loggedIn) {
        // try again if the count is not zero
        if (tryCountUntilFoundUser > 0) {
            tryCountUntilFoundUser -= 1;
            refetchUserStatusLazily(tryCountUntilFoundUser);
        }
    }
}

export async function sendHeartbeat(reason) {
    let serverIsOnline = await serverIsAvailable();
    let jwt = getItem("jwt");
    if (serverIsOnline && jwt) {
        let heartbeat = {
            pluginId: PLUGIN_ID,
            os: getOs(),
            start: nowInSecs(),
            version: getVersion(),
            hostname: await getHostname(),
            session_ctime: getSessionFileCreateTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            trigger_annotation: reason
        };
        let api = `/data/heartbeat`;
        softwarePost(api, heartbeat, jwt).then(async resp => {
            if (!isResponseOk(resp)) {
                console.log("Code Time: unable to send heartbeat ping");
            }
        });
    }
}
