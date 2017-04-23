// Import libraries
var fs = require('fs'),
    path = require('path'),
    http = require('http'),
    crypto = require('crypto'),
    moment = require('moment'),
    querystring = require('querystring'),
    syncRequest = require('sync-request'),
    tl = require('vsts-task-lib/task'),
    fileMatch = require('file-match'),
    values = require('object.values');

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

if (notPermittedFolders.length !== 0) {
    console.log('Skipping the following folders due to insufficient permissions:');
    console.log('---------------------------------------------------------------');
    notPermittedFolders.forEach(function (folder) {
        console.log(folder);
    });
    console.log('---------------------------------------------------------------');
}

//Update the diff object
directoryList.forEach(function (file) {
    var fullPath = file.path + path.sep + file.name;
    if (isFile(fullPath) && isExtensionRight(file.name)) {
        var lastModified = getLastModifiedDate(fullPath);
        addToDependencies(file.name, fullPath, lastModified);
    }
});


// +------------+
// | Sync POST |
// +------------+
console.log('Sending data to Whitesource server');
var syncRes = syncRequest('POST', hostUrl, {
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Charset': 'utf-8'
    },
    body: createPostRequest("CHECK_POLICY_COMPLIANCE") + "&diff=" + JSON.stringify(diff),
    timeout: 600000
});
var totalFiles = JSON.stringify(diff[0].dependencies.length);
console.log('Total files was scanned: ' + totalFiles);

console.log('Checking for rejections');
var responseBody = syncRes.getBody('utf8');
if (isJson(responseBody)) {
    //noinspection JSUnresolvedFunction
    var parsedRes = JSON.parse(syncRes.getBody('utf8'));
    if (parsedRes.status === 2) { //STATUS_BAD_REQUEST
        logError(error, 'Server responded with status "Bad Request", Please check your credentials');
        logError(error, 'Terminating Build');
        process.exit(1);
    }
    else if (parsedRes.status === 3) { //STATUS_SERVER_ERROR
        logError(error, 'Server responded with status "Server Error", please try again');
        logError(error, 'Terminating Build');
        process.exit(1);
    }

}
else {
    logError(error, 'Server responded with object other than "JSON"');
    logError(error, responseBody);
    logError(error, 'Terminating Build');
    process.exit(1);
}

var rejectionList = [];

var createRejectionList = function (currentNode) {
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
};

var resData = JSON.parse(parsedRes.data);
createRejectionList(resData);
var rejectionNum = rejectionList.length;


// +--------------------+
// | Result From Server |
// +--------------------+


if (rejectionNum !== 0) {
    logError('warning', "Found " + rejectionNum + ' policy rejections');
    rejectionList.forEach(function (rejection) {
        logError('warning', rejection);
    });
    if (forceUpdate === "true") {
        console.log('warning', "Some dependencies violate open source policies, however all were force updated to organization inventory.");
    }
    if (forceUpdate === "false" && checkPolicies === "FAIL_ON_BUILD") {
        logError('error', 'Terminating Build');
        process.exit(1);
    }
}
else {
    console.log('All dependencies conform with open source policies.');
}

// SECOND POST
// +------------+
// | Sync POST |
// +------------+
console.log('Sending data to Whitesource server');
syncRequest('POST', hostUrl, {
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Charset': 'utf-8'
    },
    body: createPostRequest("UPDATE") + "&diff=" + JSON.stringify(diff),
    timeout: 600000
});


console.log("Upload process done");

// +------------------+
// | Define functions |
// +------------------+

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

function creatResultOutput(responseData) {
    var wssResult = __dirname + path.sep + 'realResult.md';
    console.log(responseData);
    var totalProjects = responseData.projects;
    console.log(totalProjects);
//WRITING RESULT FILE
    if (totalProjects[0] !== null) {
        var projectName = totalProjects[0].name;
        var projectUrl = totalProjects[0].url;
        var projectNew = totalProjects[0].newlyCreated;
        var projectAlerts = totalProjects[0].totalAlerts;
        var projectVulnerable = totalProjects[0].totalVulnerableLibraries;
        var projectPolicy = totalProjects[0].totalPolicyViolations;
        // ToDo: maybe add server time instead of client time
        var projectDate = moment(totalProjects[0].date, 'MMM D, YYYY h:mm:ss A').format('dddd, MMMM D, YYYY h:mm A');
    }
    var mdFile = '<div style="padding:5px 0px"> <span>Vulnerabilities Summary:</span> </div> <table border="0" style="border-top: 1px solid #eee;border-collapse: separate;border-spacing: 0 2px;"> <table> <tr> <td>Project name</td> <td></td> <td>' + projectName + '</td> </tr> <tr> <td>Project url:</td> <td></td> <td>' + projectUrl + '</td> </tr> <tr> <td>Project new</td> <td></td> <td>' + projectNew + '</td> </tr> <tr> <td>Project totalAlerts</td> <td></td> <td>' + projectAlerts + '</td> </tr> <tr> <td>Project totalVulnerableLibraries</td> <td></td> <td>' + projectVulnerable + '</td> </tr> <tr> <td>Project totalPolicyViolations</td> <td></td> <td>' + projectPolicy + '</td> </tr> <tr> <td>Project date</td> <td></td> <td>' + projectDate + '</td> </tr> </table> <a target="_blank" href="https://saas.whitesourcesoftware.com/Wss/WSS.html">For more Information</a> </div>';
    fs.writeFile(wssResult, mdFile, function (err) {
        if (err)
            return console.log(err);
    });
    console.log("##vso[task.addattachment type=Distributedtask.Core.Summary;name=Wss Report;]" + wssResult);
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
        logError('error', err);
        return false;
    }
    return true;
}

function logError(type, str) {
    console.log('##vso[task.logissue type=' + type + ']' + str);
}

function printInfo() {
    console.log("This is from Agent: \n" + JSON.stringify(resData, null, 2) + "\n");
    console.log("Inside Json: " + JSON.stringify(resData.projectNewResources, null, 2) + "\n");
    var myArray = values(resData.projectNewResources)[0];
    for (var i = 0; i < myArray.length; i++) {
        console.log("for -> displayName: " + myArray[i].displayName + "\n");
        console.log("for -> link: " + myArray[i].link + "\n");
        console.log("for -> licenses: " + myArray[i].licenses + "\n");
        console.log("for -> sha1: " + myArray[i].sha1 + "\n");
        console.log("for -> vulnerabilities: " + myArray[i].vulnerabilities + "\n");
    }

}