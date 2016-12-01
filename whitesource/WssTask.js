// Import libraries
var fs = require('fs'),
    path = require('path'),
    http = require('http'),
    crypto = require('crypto'),
    moment = require('moment'),
    querystring = require('querystring'),
    syncRequest = require('sync-request'),
    tl = require('vsts-task-lib/task');

var service = tl.getInput('WhiteSourceService', false);
const hostUrl = tl.getEndpointUrl(service, false);
const auth = tl.getEndpointAuthorization(service, false);
var projectDir = tl.getPathInput('cwd', false);
var extensionsToHash = tl.getDelimitedInput('extensions', ' ', true);

// +-------------+
// | User Inputs |
// +-------------+

// Mandatory Fields
var type = tl.getInput('type', true);
var projectName = tl.getInput('projectName', true);

// Optional Fields
var product = tl.getInput('productNameOrToken', false);
var productVersion = tl.getInput('productVersion', false);
var requesterEmail = tl.getInput('requesterEmail', false);
var projectToken = tl.getInput('projectToken', false);
var forceCheckAllDependencies = tl.getInput('forceCheckAllDependencies', false);


// Create the "diff" JSON attribute
var diff = [{
    "coordinates": {
        "artifactId": projectName,
        "version": "1.0.0"
    },
    "dependencies": []
}];

//List the directory files recursively
console.log('Scanning project folder');
var readDirObject = readDirRecursive(projectDir);
var directoryList = readDirObject.fileList;
var notPermittedFolders = readDirObject.notPermittedFolders;

if (notPermittedFolders.length != 0) {
    console.log('Skipping the following folders due to insufficient permissions:');
    console.log('---------------------------------------------------------------');
    notPermittedFolders.forEach(function (folder) {
        console.log(folder);
    });
    console.log('---------------------------------------------------------------');
}


//Update the diff object
directoryList.forEach(function (file) {
    var fullPath = file.path + '\\' + file.name;
    if (isFile(fullPath) && isExtensionRight(file.name)) {
        var lastModified = getLastModifiedDate(fullPath);
        addToDependencies(file.name, fullPath, lastModified);
    }
});

// Build the post string from an object
var post_data = querystring.stringify({
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
post_data = post_data + "&diff=" + JSON.stringify(diff);

// +------------+
// | Sync POST |
// +------------+
console.log('Sending data to Whitesource server');
var syncRes = syncRequest('POST', hostUrl, {
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Charset': 'utf-8'
    },
    body: post_data,
    timeout: 600000
});


console.log('Checking for rejections');
var responseBody = syncRes.getBody('utf8');
if (isJson(responseBody)) {
    var parsedRes = JSON.parse(syncRes.getBody('utf8'));
    if (parsedRes.status == 2) { //STATUS_BAD_REQUEST
        logError('Server responded with status "Bad Request", Please check your credentials');
        logError('Terminating Build');
        process.exit(1);
    }
    else if (parsedRes.status == 3) { //STATUS_SERVER_ERROR
        logError('Server responded with status "Server Error", please try again');
        logError('Terminating Build');
        process.exit(1);
    }

}
else {
    logError('Server responded with object other than "JSON"');
    logError(responseBody);
    logError('Terminating Build');
    process.exit(1);
}


var resData = JSON.parse(parsedRes.data);
var rejectionList = [];

var createRejectionList = function (currentNode) {
    // the node is a leaf
    if (typeof currentNode == 'string') {
        return;
    }
    // the node is children array
    else if (Array.isArray(currentNode) && currentNode.length != 0) {
        currentNode.forEach(function (child) {
            createRejectionList(child);
        })
    } else {
        // The node if object or empty array
        var objKeys = Object.keys(currentNode);
        if (objKeys.length != 0) {
            // The node is non empty object
            var policyIndex = objKeys.indexOf('policy');
            // There is a rejected policy
            if (policyIndex != -1 && currentNode.policy.actionType == 'Reject') {
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
};

createRejectionList(resData);

 var wssResult = __dirname + '\\result.md';
 console.log("##vso[task.addattachment type=Distributedtask.Core.Summary;name=Wss Report;]" + wssResult);

// +-------------------+
// | Build Termination |
// +-------------------+
var rejectionNum = rejectionList.length;
if (rejectionNum != 0) {
    logError(rejectionNum + ' policy rejections');
    logError('Files: ');
    rejectionList.forEach(function (rejection) {
        logError(rejection);
    });
    logError('Terminating Build');
    process.exit(1);
} else {
    console.log('No policy rejections found');
}


// +------------------+
// | Define functions |
// +------------------+

function readDirRecursive(dir, fileList) {
    var notPermittedFolders = [];
    try {
        var files = fs.readdirSync(dir);
    }
    catch (err) {
        logError(err);
        return {
            fileList: []
        };
    }

    fileList = fileList || [];
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
            fs.statSync(dir + '\\' + file).isDirectory();
        }
        catch (err) {
            logError(err);
            notPermittedFolders.push(file);
            continue;
        }
        if (fs.statSync(dir + '\\' + file).isDirectory()) {
            readDirObject = readDirRecursive(dir + '\\' + file, fileList);
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

function addToDependencies(file, path, modified) {
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
    diff[0].dependencies.push(dependency);
}

function isJson(str) {
    try {
        JSON.parse(str);
    }
    catch (err) {
        logError(err);
        return false;
    }
    return true;
}

function logError(str) {
    console.log('##vso[task.logissue type=error]' + str);
}