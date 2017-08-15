// Import libraries
var fs = require('fs'),
    path = require('path'),
    crypto = require('crypto'),
    moment = require('moment'),
    querystring = require('querystring'),
    tl = require('vsts-task-lib/task'),
    fileMatch = require('file-match'),
    request = require('request');

const REQUEST_TYPE = {
        CHECK_POLICY_COMPLIANCE: 'CHECK_POLICY_COMPLIANCE',
        UPDATE: 'UPDATE'
};

var foundRejections = false;

var service = tl.getInput('WhiteSourceService', false);
const hostUrl = tl.getEndpointUrl(service, false);
const auth = tl.getEndpointAuthorization(service, false);
var projectDir = tl.getPathInput('cwd', false);
var extensionsToHash = tl.getDelimitedInput('extensions', ' ', true);
var excludeFolders = tl.getDelimitedInput('exclude', ' ', false);
var filter = fileMatch(excludeFolders);

// +-------------+
// | User Inputs |
// +-------------+

// Mandatory Fields
var checkPolicies = tl.getInput('checkPolicies', true);
var projectName = tl.getInput('projectName', true);

// Optional Fields
var product = tl.getInput('productNameOrToken', false);
var productVersion = tl.getInput('productVersion', false);
var requesterEmail = tl.getInput('requesterEmail', false);
var projectToken = tl.getInput('projectToken', false);
var forceCheckAllDependencies = tl.getInput('forceCheckAllDependencies', false);
var forceUpdate = tl.getInput('forceUpdate', false);


runPlugin();

function runPlugin() {
    var scannedFiles = scanAllFiles();
    var dependencies = getDependenciesFromFiles(scannedFiles.fileList);

    var checkPolicyComplianceRequest = createFullRequest(REQUEST_TYPE.CHECK_POLICY_COMPLIANCE, dependencies);
    sendRequest(checkPolicyComplianceRequest, function (err, response) {
            console.log("Error:" + JSON.stringify(err));
            console.log("Server response:" + JSON.stringify(response));
    }, function(responseBody) {
        onCheckPolicyComplianceSuccess(responseBody);
        var updateRequest = createFullRequest(REQUEST_TYPE.UPDATE, dependencies);
        sendUpdateRequest(updateRequest)
    });

    // inner function
    function sendUpdateRequest(updateRequest) {
        if (foundRejections) {
            if (forceUpdate === "true") {
                console.log('Sending data to Whitesource server');
                tl.debug('Full force update post request as sent to server: ' + JSON.stringify(updateRequest));

                sendRequest(updateRequest, function (err, response) {
                    console.log("Unable to send update request");
                    console.log("Error:" + JSON.stringify(err));
                    console.log("Server response:" + JSON.stringify(response));
                }, function (responseBody) {
                    console.log("Update request response body: " + JSON.stringify(responseBody));
                    console.log("Upload process done");
                    console.log('warning', "Organization was updated even though some dependencies violate organizational policies.");
                });

            }
            if (checkPolicies === "FAIL_ON_BUILD") {
                logError('error', 'Terminating Build');
                process.exit(1);
            }
        } else {
            console.log('Sending data to Whitesource server');
            sendRequest(updateRequest, function (err, response) {
                console.log("Unable to send update request");
                console.log("Error:" + JSON.stringify(err));
                console.log("Server response:" + JSON.stringify(response));
            }, function (responseBody) {
                console.log("Update request response body: " + JSON.stringify(responseBody));
                console.log("Upload process done");
            });
        }
    }
}

function scanAllFiles() {
    console.log('Scanning project folder');
    var readDirObject = readDirRecursive(projectDir); // list the directory files recursively
    var notPermittedFolders = readDirObject.notPermittedFolders;

    if (notPermittedFolders.length !== 0) {
        console.log('Skipping the following folders due to insufficient permissions:');
        console.log('---------------------------------------------------------------');
        notPermittedFolders.forEach(function (folder) {
            console.log(folder);
        });
        console.log('---------------------------------------------------------------');
    }
    tl.debug('Scan files result: ' + JSON.stringify(readDirObject));
    console.log('Finished discovering all files');
    return readDirObject;
}

function getDependenciesFromFiles(files) {
    var dependencies = [];

    files.forEach(function (file) {
        var fullPath = file.path + path.sep + file.name;
        if (isFile(fullPath) && isExtensionRight(file.name)) {
            var lastModified = getLastModifiedDate(fullPath);
            var dependency = getDependencyInfo(file.name, fullPath, lastModified);
            if (dependency) {
                dependencies.push(dependency);
            }
        }
    });
    console.log('Suspected dependencies found: ' + dependencies.length);
    tl.debug('All suspected dependency infos: ' + JSON.stringify(dependencies));
    return dependencies;
}

function createFullRequest(requestType, dependencies) {
    var requestInventory = [{
        "coordinates": {
            "artifactId": projectName,
            "version": "1.0.0"
        },
        "dependencies": dependencies
    }];
    var body = createPostRequest(requestType) + "&diff=" + JSON.stringify(requestInventory);

    return {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Charset': 'utf-8'
        },
        body: body,
        timeout: 3600000,
        method: 'post',
        url: hostUrl
    };
}

function createPostRequest(type) {
    return querystring.stringify({
        "agent": "tfs-plugin",
        "agentVersion": "1.0",
        "type": type,
        "token": auth.parameters.apitoken,
        "timeStamp": new Date().getTime(),
        "product": product,
        "productVersion": productVersion,
        "requesterEmail": requesterEmail,
        "projectToken": projectToken,
        "forceCheckAllDependencies": forceCheckAllDependencies
    });
}

function sendRequest(fullRequest, onError, onSuccess) {
    tl.debug('Full post request as sent to server: ' + JSON.stringify(fullRequest));
    request(fullRequest, function (err, response, responseBody) {
        if (err && onError) {
            onError(err, response);
        }
        if (response) {
            var statusCode = response.statusCode;
            if ((statusCode >= 200 && statusCode < 300) || statusCode === 304) {
                if (onSuccess) {
                    onSuccess(responseBody);
                }
            } else if (statusCode === 407) {
                console.log('Build agent is unable to authenticate against the proxy server.' +
                    '\nPlease ask the Team Foundation administrator to add VSTS_HTTP_PROXY_USERNAME and ' +
                    'VSTS_HTTP_PROXY_PASSWORD as build agent environment variables.' +
                    '\nUnable to proceed with WhiteSource Bolt task.');
                console.log('##vso[task.complete result=Failed]');
            }
            // } else if (statusCode === 403 && httpsProxy) {
            //         console.log('ERROR: Unable to send requests due to proxy restrictions.\n' +
            //             'Please make sure to add "whitesourcesoftware.com" domain name and it\'s sub domains ' +
            //             'to your proxy whitelist.');
            //         console.log('##vso[task.complete result=Failed]');
            //         process.exit(0);
            // } else {
            //         console.log('Response status code ' + statusCode + '\nUnable to proceed with request');
            //         task.debug('Entire http response is:\n' + JSON.stringify(entireResponse));
            //         console.log('Unable to proceed with WhiteSource Bolt task.');
            //         console.log('##vso[task.complete result=Failed]');
            //         process.exit(0);
            // }
        }
    });
}

function onCheckPolicyComplianceSuccess(responseBody) {
    if (isJson(responseBody)) {
        tl.debug('Server response: ' + JSON.stringify(responseBody));
        if (responseBody.status === 2) { //STATUS_BAD_REQUEST
            logError('error', 'Server responded with status "Bad Request", Please check your credentials');
            logError('error', 'Terminating Build');
            process.exit(1);
        }
        else if (responseBody.status === 3) { //STATUS_SERVER_ERROR
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

    if (responseBody.data) {

        // tl.debug('Json parsed response ' + JSON.parse(responseBody.data));
        tl.debug('Json not parsed response ' + responseBody.data);
        var rejectionList = getRejectionList(JSON.parse(responseBody.data));

        var rejectionNum = rejectionList.length;

        if (rejectionNum !== 0) {
            logError('warning', "Found " + rejectionNum + ' policy rejections');
            rejectionList.forEach(function (rejection) {
                logError('warning', rejection);
            });
        }
        else {
            console.log('All dependencies conform with open source policies.');
        }

        foundRejections = true;
    }
}

function getRejectionList(data) {
    var rejectionList = [];
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
                var policyIndex = objKeys.indexOf('policy');
                // There is a rejected policy
                if (policyIndex !== -1 && currentNode.policy.actionType === 'Reject') {
                    var file_name = currentNode.resource.displayName;
                    rejectionList.push(file_name);
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

function getDependencyInfo(file, path, modified) {
    var hash = hashFile(path);
    var dependency = {
        "artifactId": file,
        "sha1": hash,
        "otherPlatformSha1": "",
        "systemPath": path,
        "optional": false,
        "children": [],
        "exclusions": [],
        "licenses": [],
        "copyrights": [],
        "lastModified": modified
    };

    return dependency;
}

function isJson(str) {
    try {
        JSON.parse(str);
    }
    catch (err) {
        logError('error', err);
        return false;
    }
    return true;
}

function readDirRecursive(dir, fileList) {
    var notPermittedFolders = [];
    try {
        var files = fs.readdirSync(dir);
    }
    catch (err) {
        logError('error', err);
        return {
            fileList: []
        };
    }

    fileList = fileList || [];
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
            fs.statSync(dir + path.sep + file).isDirectory();
        }
        catch (err) {
            logError('error', err);
            notPermittedFolders.push(file);
            continue;
        }

        var fullPath = dir + path.sep + file;
        if (filter(fullPath)) {
            //skip -> Exclude list
        }
        else if (fs.statSync(fullPath).isDirectory()) {
            readDirObject = readDirRecursive(fullPath, fileList);
            fileList = readDirObject.fileList;
        } else {
            fileList.push({'name': file, 'path': dir});
        }
    }
    return {
        fileList: fileList,
        notPermittedFolders: notPermittedFolders
    };
}

function isFile(path) {
    var stats = fs.statSync(path);
    return stats.isFile();
}

function isExtensionRight(file) {
    var fileExtension = path.extname(file);
    if (extensionsToHash.indexOf(fileExtension) > -1) {
        return true;
    }
}

function hashFile(path) {
    //Gets file name and return it SHA1 hashed
    var fileData = fs.readFileSync(path);
    var shasum = crypto.createHash('sha1');
    shasum.update(fileData);
    return shasum.digest('hex');
}

function getLastModifiedDate(path) {
    var stats = fs.statSync(path);
    return moment(stats.mtime).format("MMM D, YYYY h:mm:ss A")
}

function logError(type, str) {
    console.log('##vso[task.logissue type=' + type + ']' + str);
}

// +------------+
// | Sync POST |
// +------------+