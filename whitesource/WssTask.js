// Import libraries
const fs = require('fs'),
    moment = require('moment'),
    querystring = require('querystring'),
    tl = require('vsts-task-lib/task'),
    request = require('request'),
    httpsProxyAgent = require('https-proxy-agent'),
    globAll = require('glob-all');

const hashCalculator = require('./HashCalculator');
const constants = require('./constants');

// Plugin configuration params
const wssService = tl.getInput('WhiteSourceService', false);
const destinationUrl = tl.getEndpointUrl(wssService, false);
const serviceAuthorization = tl.getEndpointAuthorization(wssService, false);
const cwd = tl.getPathInput('cwd', false);

// User Mandatory Fields
const checkPolicies = tl.getInput('checkPolicies', true);
const includedExtensions = tl.getDelimitedInput('extensions', ' ', true);

// User Optional Fields
const excludeFolders = tl.getDelimitedInput('exclude', ' ', false);
const requesterEmail = tl.getInput('requesterEmail', false);
const isForceCheckAllDependencies = tl.getInput('forceCheckAllDependencies', false);
const isForceUpdate = tl.getInput('forceUpdate', false);
const proxyUsername = tl.getInput('proxyUsername', false);
const proxyPassword = tl.getInput('proxyPassword', false);
const connectionTimeoutField = tl.getInput('connectionTimeoutField', false);
const connectionRetries = tl.getInput('connectionRetries', 1);
const connectionRetriesInterval = tl.getInput('connectionRetriesInterval', 3);
const projectRule = tl.getInput('projectRule', true);
const productRule = tl.getInput('productRule', true);

let proxy = tl.getInput('proxyUrl', false);
let projectName = tl.getInput('projectName', false);
let projectToken = tl.getInput('projectToken', false);
let productName = tl.getInput('productName', false);
let productToken = tl.getInput('productToken', false);
let productVersion = tl.getInput('productVersion', false);

// General global variables
const PLUGIN_VERSION = '20.5.2';
const REQUEST_TYPE = {
    CHECK_POLICY_COMPLIANCE: 'CHECK_POLICY_COMPLIANCE',
    UPDATE: 'UPDATE'
};

let foundRejections = false;
let httpsProxy = undefined;
let connectionTimeout = 3600000;

// Run actual plugin work
runPlugin();

function runPlugin() {
    checkProjectAndProduct();
    findProxySettings();

    let scannedFiles = getAllFilesToScan();
    let dependencies = getDependenciesFromFiles(scannedFiles);

    let checkPolicyComplianceRequest = createFullRequest(REQUEST_TYPE.CHECK_POLICY_COMPLIANCE, dependencies);
    console.log('Sending check policies request to WhiteSource server');
    sendRequest(checkPolicyComplianceRequest, onErrorRequest, connectionRetries, function (responseBody) {
        tl.debug('Check policies response: ' + JSON.stringify(responseBody));
        onCheckPolicyComplianceSuccess(responseBody);
        let updateRequest = createFullRequest(REQUEST_TYPE.UPDATE, dependencies);
        sendUpdateRequest(updateRequest)
    });
}

function findProxySettings() {
    // find the actual proxy url
    if (!proxy) {
        proxy = tl.getVariable('VSTS_HTTP_PROXY'); // usually undefined but check for backwards compatibility
    }
    if (!proxy) {
        proxy = tl.getVariable('AGENT_PROXYURL');
    }

    if (proxy) {
        console.log('Proxy settings detected.');
        // check if there are proxy credentials  and construct the proxy url with credentials
        if (proxyUsername && proxyPassword) {
            httpsProxy = getAuthenticatedProxy(proxyUsername, proxyPassword);
        } else if (tl.getVariable('VSTS_HTTP_PROXY_USERNAME') && tl.getVariable('VSTS_HTTP_PROXY_PASSWORD')) {
            httpsProxy = getAuthenticatedProxy(tl.getVariable('VSTS_HTTP_PROXY_USERNAME'), tl.getVariable('VSTS_HTTP_PROXY_PASSWORD'));
        } else {
            httpsProxy = new httpsProxyAgent(proxy);
        }
    } else {
        tl.debug('No build agent proxy settings found.')
    }
}

function getAuthenticatedProxy(proxyUsername, proxyPassword) {
    let index = proxy.lastIndexOf('://') + 3; // the actual index of '/'
    let authenticatedProxy = proxy.substr(0, index) + proxyUsername + ':' +
        proxyPassword + '@' + proxy.substr(index, proxy.length);
    console.log('Proxy username and password found.');
    return new httpsProxyAgent(authenticatedProxy);
}

function getAllFilesToScan() {
    console.log('Start discovering project folder files');

    let includePatterns = [];

    // Add glob pattern '**/*" to extensions to search them in all project
    includedExtensions.forEach(function (extension) {
        includePatterns.push(constants.GLOB_PATTERN + extension);
    });

    // Sync all files that meet the requirements - included extensions and excludeFolders patterns
    // Returned files are with absolute path since "absolute" is true in options
    const globOptions = {cwd: cwd, dot: true, nodir: true, absolute: true, ignore: excludeFolders};
    let allFilesToScan = globAll.sync(includePatterns, globOptions);

    tl.debug('Scan files result: ' + JSON.stringify(allFilesToScan));
    console.log('Finished discovering all files');
    return allFilesToScan;
}

function getDependenciesFromFiles(files) {
    let dependencies = [];

    files.forEach(function (file) {
        let lastModified = getLastModifiedDate(file);
        let dependency = getDependencyInfo(file, lastModified);
        if (dependency) {
            dependencies.push(dependency);
        }
    });

    console.log('Suspected dependencies found: ' + dependencies.length);
    tl.debug('All suspected dependency infos: ' + JSON.stringify(dependencies));
    return dependencies;
}

function createFullRequest(requestType, dependencies) {
    let requestInventory = [{
        "coordinates": {
            "artifactId": projectName,
            "version": "1.0.0"
        },
        "dependencies": dependencies,
        "projectToken": projectToken,
    }];
    if (connectionTimeoutField != null) {
        connectionTimeout = connectionTimeoutField * 60 * 1000;
    }

    let body = createPostRequest(requestType) + "&diff=" + JSON.stringify(requestInventory);

    let request = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Charset': 'utf-8'
        },
        body: body,
        timeout: connectionTimeout,
        method: 'post',
        url: destinationUrl
    };

    if (httpsProxy) {
        request.agent = httpsProxy;
    }

    return request;
}

function createPostRequest(type) {

    return querystring.stringify({
        "agent": "tfs-plugin",
        "agentVersion": PLUGIN_VERSION,
        "type": type,
        "token": serviceAuthorization.parameters.apitoken,
        "userKey": serviceAuthorization.parameters.userKey,
        "timeStamp": new Date().getTime(),
        "productToken": productToken,
        "product": productName,
        "productVersion": productVersion,
        "requesterEmail": requesterEmail,
        "projectToken": projectToken,
        "forceCheckAllDependencies": isForceCheckAllDependencies,
        "connectionRetries": connectionRetries,
        "connectionRetriesInterval": connectionRetriesInterval
    });
}

function sendRequest(fullRequest, onError, connectionRetries, onSuccess) {
    tl.debug('Full post request as sent to server: ' + JSON.stringify(fullRequest));
    let statusCode;
    request(fullRequest, function (err, response, responseBody) {
        if (err && onError) {
            onError(err);
        }
        console.log();

        if (response) {
            statusCode = response.statusCode;
            if ((statusCode >= 200 && statusCode < 300) || statusCode === 304) {
                if (onSuccess) {
                    onSuccess(responseBody);
                }
            } else if (statusCode === 407) {
                console.log('Build agent is unable to authenticate against the proxy server.' +
                    '\nPlease ask the Team Foundation administrator to add VSTS_HTTP_PROXY_USERNAME and ' +
                    'VSTS_HTTP_PROXY_PASSWORD as build agent environment variables.' +
                    '\nUnable to proceed with WhiteSource task.');
                console.log('##vso[task.complete result=Failed]');
                process.exit(1);
            } else if (statusCode === 403 && httpsProxy) {
                console.log('ERROR: Unable to send requests due to proxy restrictions.\n' +
                    'Please make sure to add "whitesourcesoftware.com" domain name and it\'s sub domains ' +
                    'to your proxy whitelist.');
                console.log('##vso[task.complete result=Failed]');
                process.exit(1);
            } else {
                console.log('Response status code ' + statusCode + '\nUnable to proceed with request');
                tl.debug('Entire http response is:\n' + JSON.stringify(response));
                console.log('Unable to proceed with WhiteSource task.');
                console.log('##vso[task.complete result=Failed]');

                if (connectionRetries >= 0) {
                    console.error("Failed to send request to WhiteSource server");
                    if (connectionRetries > 0) {
                        connectionRetries--;
                        console.error("Trying " + (connectionRetries + 1) + " more time" + (connectionRetries != 0 ? "s" : ""));
                        setSleepTimeOut(connectionRetriesInterval * 1000)
                        sendRequest(fullRequest, onError, connectionRetries, onSuccess);
                    }
                }
            }
        }
    });
}

function onCheckPolicyComplianceSuccess(responseBody) {
    if (isJson(responseBody)) {
        if (responseBody.status === 2) { //STATUS_BAD_REQUEST
            logError('error', 'Server responded with status "Bad Request", Please check your credentials');
            logError('error', 'Terminating Build');
            process.exit(1);
        } else if (responseBody.status === 3) { //STATUS_SERVER_ERROR
            logError('error', 'Server responded with status "Server Error", please try again');
            logError('error', 'Terminating Build');
            process.exit(1);
        }
    } else {
        logError('error', 'Server responded with object other than "JSON"');
        logError('error', responseBody);
        logError('error', 'Terminating Build');
        process.exit(1);
    }

    try {
        var jsonResponse = JSON.parse(responseBody);
        var responseData = JSON.parse(jsonResponse.data);
    } catch (err) {
        logError('error', 'Unable to parse check policy response data, error: ' + err);
    }

    if (responseData) {
        let rejectionList = getRejectionList(responseData);
        if (rejectionList.length !== 0) {
            logError('warning', "Found " + rejectionList.length + ' policy rejections');
            rejectionList.forEach(function (rejection) {
                logError('warning', 'Resource ' + rejection.resourceName + ' was rejected by policy "' + rejection.policyName + '"');
            });
            foundRejections = true;
        } else {
            console.log('All dependencies conform with open source policies.');
        }
    }
}

function sendUpdateRequest(updateRequest) {
    if (foundRejections) {
        if (isForceUpdate === "true") {
            console.log('Sending force update inventory request to WhiteSource server');
            tl.debug('Full force update post request: ' + JSON.stringify(updateRequest));

            sendRequest(updateRequest, onErrorRequest, connectionRetries, function (responseBody) {
                tl.debug("Force update response: " + JSON.stringify(responseBody));
                console.log('warning', "Inventory was updated even though some dependencies violate policies.");
                showUpdateServerResponse(responseBody);
            });
        } else {
            if (checkPolicies === "FAIL_ON_BUILD") {
                logError('error', 'Terminating Build upon policy violations');
                process.exit(1);
            }
        }
    } else {
        console.log('Sending update inventory request to WhiteSource server');
        sendRequest(updateRequest, onErrorRequest, connectionRetries, function (responseBody) {
            tl.debug("Update request response: " + JSON.stringify(responseBody));
            showUpdateServerResponse(responseBody);
        });
    }
}

function onErrorRequest(err) {
    console.log("Error sending request:" + JSON.stringify(err));
    if (err.code == "ESOCKETTIMEDOUT") {
        console.log("Please consider to update the 'Connection timeout' under your WhiteSource task settings");
    }

}

function showUpdateServerResponse(response) {
    let jsonResponse = JSON.parse(response);
    let responseData;
    try {
        responseData = JSON.parse(jsonResponse.data);
    } catch (err) {
        console.log("Error in updating WhiteSource: " + jsonResponse.data);
        process.exit(1);
    }

    if (responseData) {
        if (responseData.organization) {
            console.log('Organization ' + responseData.organization + ' was updated');
        }
        if (responseData.updatedProjects && responseData.updatedProjects.length > 0) {
            console.log('Updated projects ' + responseData.updatedProjects.join(','));
        } else {
            console.log('No project were updated');
        }
        if (responseData.createdProjects && responseData.createdProjects.length > 0) {
            console.log('Created projects ' + responseData.createdProjects.join(','));
        } else {
            console.log('No new project were created');
        }
        if (responseData.requestToken) {
            console.log('Support request token ' + responseData.requestToken);
        }
    }
}

function getRejectionList(data) {
    let rejectionList = [];
    createRejectionList(data);
    return rejectionList;

    // inner functions
    function createRejectionList(currentNode) {
        // the node is a leaf
        if (typeof currentNode === 'string') {
            return;
        }
        // the node is children array
        else if (Array.isArray(currentNode) && currentNode.length !== 0) {
            currentNode.forEach(function (child) {
                createRejectionList(child);
            })
        } else {
            // The node if object or empty array
            var objKeys = Object.keys(currentNode);
            if (objKeys.length !== 0) {
                // The node is non empty object
                let policyIndex = objKeys.indexOf('policy');
                // There is a rejected policy
                if (policyIndex !== -1 && currentNode.policy.actionType === 'Reject') {
                    let rejectionInfo = {
                        resourceName: currentNode.resource.displayName,
                        policyName: currentNode.policy.displayName
                    };
                    rejectionList.push(rejectionInfo);
                } else {
                    // Keep on going
                    objKeys.forEach(function (key) {
                        createRejectionList(currentNode[key]);
                    })
                }
            } else {
                // Empty object or array
                return;
            }
        }
    }
}

function getDependencyInfo(path, modified) {

    let fileName = getFileNameFromPath(path);
    let sha1AndOtherPlatformSha1 = hashCalculator.getSha1(path);
    let hashCalculationResult = hashCalculator.calculateSuperHash(path, fileName);

    tl.debug("Complete calculating Sha1 of " + path + " sha1: " + sha1AndOtherPlatformSha1.sha1 + " Other Platform Sha1: " + sha1AndOtherPlatformSha1.otherPlatformSha1);
    if (hashCalculationResult != null) {
        tl.debug("fullFileHash: " + hashCalculationResult.fullHash + ", mostSigBitsHash: " + hashCalculationResult.mostSigBitsHash + ", leastSigBitsHash: " + hashCalculationResult.leastSigBitsHash);
    }

    fileName = encodeURIComponent(fileName);
    let i = path.lastIndexOf('\\');
    if (i !== -1) {
        path = path.substr(0, i) + "\\" + fileName;
    }
    return {
        "artifactId": fileName,
        "sha1": sha1AndOtherPlatformSha1.sha1,
        "otherPlatformSha1": sha1AndOtherPlatformSha1.otherPlatformSha1,
        "fullHash": (hashCalculationResult == null) ? null : hashCalculationResult.fullHash,
        "mostSigBitsHash": (hashCalculationResult == null) ? null : hashCalculationResult.mostSigBitsHash,
        "leastSigBitsHash": (hashCalculationResult == null) ? null : hashCalculationResult.leastSigBitsHash,
        "systemPath": path,
        "optional": false,
        "children": [],
        "exclusions": [],
        "licenses": [],
        "copyrights": [],
        "lastModified": modified
    };
}

function isJson(str) {
    try {
        JSON.parse(str);
    } catch (err) {
        logError('error', err);
        return false;
    }
    return true;
}

function getLastModifiedDate(path) {
    let stats = fs.statSync(path);
    return moment(stats.mtime).format("MMM D, YYYY h:mm:ss A")
}

function logError(type, str) {
    console.log('##vso[task.logissue type=' + type + ']' + str);
}

function setSleepTimeOut(milSeconds) {
    let e = new Date().getTime() + milSeconds;
    while (new Date().getTime() <= e) {
    }
}

/*
 * Get file name from file full path, Works for forward and backward slashes
 * For example - filePath="C:\folderPath\myFileName.extension, Returns myFileName.extension
 */
function getFileNameFromPath(filePath) {
    return filePath.replace(/^.*[\\\/]/, '');
}

function checkProjectAndProduct() {
    if (projectRule === "projectToken" && projectName !== '') {
        projectName = "";
    } else if (projectRule === "projectName" && projectToken !== '') {
        projectToken = "";
    } else if (productRule === "productName" && productToken !== '') {
        productToken = "";
    } else if (productRule === "productToken" && productName !== '') {
        productName = "";
    }
}