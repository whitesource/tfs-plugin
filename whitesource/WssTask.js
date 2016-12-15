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
if(type == "CHECK_POLICY_COMPLIANCE"){}
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
    var fullPath = file.path + path.sep + file.name;
    if (isFile(fullPath) && isExtensionRight(file.name)) {
        var lastModified = getLastModifiedDate(fullPath);
        addToDependencies(file.name, fullPath, lastModified);
    }
});
function createPostRequest(){
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
    return post_data;
}
if(type == "CHECK_POLICY_COMPLIANCE") {
// Build the post string from an object
//     var post_data = querystring.stringify({
//         "agent": "tfs-plugin",
//         "agentVersion": "1.0",
//         "type": type,
//         "token": auth.parameters.apitoken,
//         "timeStamp": new Date().getTime(),
//         "product": product,
//         "productVersion": productVersion,
//         "requesterEmail": requesterEmail,
//         "projectToken": projectToken,
//         "forceCheckAllDependencies": forceCheckAllDependencies
//     });
     var post_data = createPostRequest() + "&diff=" + JSON.stringify(diff);


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
    var totalFiles = JSON.stringify(diff[0].dependencies.length);
    console.log('Total files was scanned: ' + totalFiles);


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

    var resData = JSON.parse(parsedRes.data);
    createRejectionList(resData);
    var rejectionNum = rejectionList.length;


// +--------------------+
// | Result From Server |
// +--------------------+


    if (rejectionNum != 0) {
        logError(rejectionNum + ' policy rejections');
        logError('Files: ');
        rejectionList.forEach(function (rejection) {
            logError(rejection);
        });
        logError('Terminating Build');
        process.exit(1);
    }
    else {
        //creatResultOutput(resData);
        console.log('No policy rejections found');
    }
}

// Build the post string from an object
var post_data = querystring.stringify({
    "agent": "tfs-plugin",
    "agentVersion": "1.0",
    "type": "UPDATE",
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
var totalFiles = JSON.stringify(diff[0].dependencies.length);
console.log('Total files was scanned: ' + totalFiles);


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

var resData = JSON.parse(parsedRes.data);
createRejectionList(resData);
var rejectionNum = rejectionList.length;


// +--------------------+
// | Result From Server |
// +--------------------+


if (rejectionNum != 0) {
    logError(rejectionNum + ' policy rejections');
    logError('Files: ');
    rejectionList.forEach(function (rejection) {
        logError(rejection);
    });
    logError('Terminating Build');
    process.exit(1);
}
else {
    creatResultOutput(resData);
    console.log('No policy rejections found');
}



// var wssResult = __dirname + '\\realResult.md';
// if (rejectionNum != 0) {
//     var totalProjects = resData.projects;
//     var firstArray = totalProjects[0];
// //WRITING RESULT FILE
//     if (totalProjects[0] != null) {
//         var projectName = totalProjects[0].name;
//         var projectUrl = totalProjects[0].url;
//         var projectNew = totalProjects[0].newlyCreated;
//         var projectAlerts = totalProjects[0].totalAlerts;
//         var projectVulnerable = totalProjects[0].totalVulnerableLibraries;
//         var projectPolicy = totalProjects[0].totalPolicyViolations;
// // ToDo: maybe add server time instead of client time
//         var formatted = moment(totalProjects[0].date, 'MMM D, YYYY h:mm:ss A').format('dddd, MMMM D, YYYY h:mm A');
//         var projectDate = formatted;
//     }
// // var mdFile = '<div style="padding:5px 0px"> <span>Vulnerabilities Summary:</span> </div> <table border="0" style="border-top: 1px solid #eee;border-collapse: separate;border-spacing: 0 2px;">Project name:' + projectName + ' <br>Project url:' + projectUrl + ' <br>Project new:' + projectNew + ' <br>Project totalAlerts:' + projectAlerts + ' <br>Project totalVulnerableLibraries:' + projectVulnerable + ' <br>Project totalPolicyViolations:' + projectPolicy + ' <br>Project date:' + projectDate + ' <br> <table> <tr> <td>Project name</td> <td>' + projectName + '</td> </tr> <tr> <td>Project url:</td> <td>' + projectUrl + '</td> </tr> <tr>\<td>Project new</td> <td>' + projectNew + '</td> </tr> </table> <a target="_blank" href="https://saas.whitesourcesoftware.com/Wss/WSS.html">For more Information</a> </div>';
//     var mdFile = '<div style="padding:5px 0px"> <span>Vulnerabilities Summary:</span> </div> <table border="0" style="border-top: 1px solid #eee;border-collapse: separate;border-spacing: 0 2px;"> <table> <tr> <td>Project name</td> <td></td> <td>' + projectName + '</td> </tr> <tr> <td>Project url:</td> <td></td> <td>' + projectUrl + '</td> </tr> <tr> <td>Project new</td> <td></td> <td>' + projectNew + '</td> </tr> <tr> <td>Project totalAlerts</td> <td></td> <td>' + projectAlerts + '</td> </tr> <tr> <td>Project totalVulnerableLibraries</td> <td></td> <td>' + projectVulnerable + '</td> </tr> <tr> <td>Project totalPolicyViolations</td> <td></td> <td>' + projectPolicy + '</td> </tr> <tr> <td>Project date</td> <td></td> <td>' + projectDate + '</td> </tr> </table> <a target="_blank" href="https://saas.whitesourcesoftware.com/Wss/WSS.html">For more Information</a> </div>';
//     fs.writeFile(wssResult, mdFile, function (err) {
//         if (err)
//             return console.log(err);
//     });
// }
// else {
//     var mdFile = '<div style="padding:5px 0px"> <H2><span>Policy rejection occurred </span></H2></div>';
//     fs.writeFile(wssResult, mdFile, function (err) {
//         if (err)
//             return console.log(err);
//     });
// }

//var wssResult = __dirname + '\\result.md';

// console.log("##vso[task.addattachment type=Distributedtask.Core.Summary;name=Wss Report;]" + wssResult);

// +-------------------+
// | Build Termination |
// +-------------------+

// if (rejectionNum != 0) {
//     logError(rejectionNum + ' policy rejections');
//     logError('Files: ');
//     rejectionList.forEach(function (rejection) {
//         logError(rejection);
//     });
//     logError('Terminating Build');
//     process.exit(1);
// } else {
//     console.log('No policy rejections found');
// }


// +------------------+
// | Define functions |
// +------------------+

function creatResultOutput(responseData) {
    var wssResult = __dirname + path.sep+ 'realResult.md';
    console.log(responseData);
    var totalProjects = responseData.projects;
    console.log(totalProjects);
//WRITING RESULT FILE
    if (totalProjects[0] != null) {
        var projectName = totalProjects[0].name;
        var projectUrl = totalProjects[0].url;
        var projectNew = totalProjects[0].newlyCreated;
        var projectAlerts = totalProjects[0].totalAlerts;
        var projectVulnerable = totalProjects[0].totalVulnerableLibraries;
        var projectPolicy = totalProjects[0].totalPolicyViolations;
// ToDo: maybe add server time instead of client time
        var formatted = moment(totalProjects[0].date, 'MMM D, YYYY h:mm:ss A').format('dddd, MMMM D, YYYY h:mm A');
        var projectDate = formatted;
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
        logError(err);
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
            logError(err);
            notPermittedFolders.push(file);
            continue;
        }
        if (fs.statSync(dir + path.sep + file).isDirectory()) {
            readDirObject = readDirRecursive(dir + path.sep + file, fileList);
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