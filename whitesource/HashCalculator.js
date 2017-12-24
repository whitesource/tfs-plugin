/**
 * @author raz.nitzan
 */

var fs = require('fs');
var tl = require('vsts-task-lib/task');
var crypto = require('crypto');
var converter = require('convert-string');
var constants = require('./constants');
var FileExtensions = require('./FileExtensions');

var BINARY_FILE_EXTENSION_REGEX = null;

function HashCalculationResult(fullHash, mostSigBitsHash, leastSigBitsHash) {
    this.fullHash = fullHash;
    this.mostSigBitsHash = mostSigBitsHash;
    this.leastSigBitsHash = leastSigBitsHash;
}

function calculateSuperHash(filePath, fileName) {
    if (!checkIfFileIsBinary(fileName)) {
        try {
            var fileSize = getFileSizeInBytes(filePath);
            tl.debug("The size of: " + filePath + " is " + fileSize);
            if (fileSize <= constants.FILE_MIN_SIZE_THRESHOLD) {
                tl.debug("Ignored file " + file.getName() + " (" + fileSize + "B): minimum file size is 512B");
                return null;
            }
            var fileData = fs.readFileSync(filePath, {encoding: constants.UTF_8});
            tl.debug("Calculate super hash of: " + filePath);
            return getSuperHash(converter.UTF8.stringToBytes(fileData));
        } catch (e) {
            tl.debug("Failed calculating SHA-1 for file " + filePath);
            return null;
        }
    } else {
        return null;
    }
}

function checkIfFileIsBinary(fileName) {
    if (BINARY_FILE_EXTENSION_REGEX == null) {
        BINARY_FILE_EXTENSION_REGEX = FileExtensions.buildBinaryRegex();
    }
    tl.debug(BINARY_FILE_EXTENSION_REGEX);
    return fileName.toLowerCase().match(BINARY_FILE_EXTENSION_REGEX);
}

exports.calculateSuperHash = calculateSuperHash;

function getSuperHash(arrayOfBytes) {
    var result = null;
    var bytesWithoutSpaces = stripWhiteSpaces(arrayOfBytes);
    var fileSizeWithoutSpaces = bytesWithoutSpaces.length;
    if (fileSizeWithoutSpaces < constants.FILE_MIN_SIZE_THRESHOLD) {
        tl.debug("Ignored file " + file.getName() + " (" + fileSizeWithoutSpaces + "B): minimum file size is 512B");
    } else if (fileSizeWithoutSpaces <= constants.FILE_PARTIAL_HASH_MIN_SIZE) {
        var fullFileHash = getSha1FromData(Buffer.from(bytesWithoutSpaces));
        result = new HashCalculationResult(fullFileHash, null, null);
    } else if (fileSizeWithoutSpaces <= constants.FILE_SMALL_SIZE) {
        result = hashBuckets(bytesWithoutSpaces, constants.FILE_SMALL_BUCKET_SIZE);
    } else {
        var baseLowNumber = 1;
        var digits = Math.floor(Math.log(fileSizeWithoutSpaces) / Math.log(10));
        var i = 0;
        while (i < digits) {
            baseLowNumber = baseLowNumber * 10;
            i++;
        }
        var highNumber = Math.ceil((fileSizeWithoutSpaces + 1) / (baseLowNumber + 0.0)) * baseLowNumber;
        var lowNumber = highNumber - baseLowNumber;
        var bucketSize = (highNumber + lowNumber) / 4;
        result = hashBuckets(bytesWithoutSpaces, bucketSize);
    }
    return result;
}

function hashBuckets(fileWithoutSpaces, bucketSize) {
    var intBucketSize = Math.floor(bucketSize);
    var mostSigBytes = fileWithoutSpaces.slice(0, intBucketSize);
    var length = fileWithoutSpaces.length;
    var leastSigBytes = fileWithoutSpaces.slice(length - intBucketSize, length);
    var fullFileHash = getSha1FromData(Buffer.from(fileWithoutSpaces));
    var mostSigBitsHash = getSha1FromData(Buffer.from(mostSigBytes));
    var leastSigBitsHash = getSha1FromData(Buffer.from(leastSigBytes));
    return new HashCalculationResult(fullFileHash, mostSigBitsHash, leastSigBitsHash);
}

function stripWhiteSpaces(bytesArray) {
    var arrayWithoutSpaces = new Array();
    for (var byte in bytesArray) {
        if (constants.WHITESPACE.indexOf(bytesArray[byte]) < 0) {
            arrayWithoutSpaces.push(bytesArray[byte]);
        }
    }
    return arrayWithoutSpaces;
}

function getSha1(path) {
    //Gets file name and return it SHA1 hashed
    var fileData = fs.readFileSync(path);
    var sha1 =  getSha1FromData(fileData);
    var otherPlatformSha1 = null;
    if (getFileSizeInBytes(path) < constants.MAX_FILE_SIZE) {
        var fileDataString = fileData.toString();
        if (fileDataString.indexOf(constants.CRLF)) {
            otherPlatformSha1 = getSha1FromData(fileDataString.replace(new RegExp(constants.CRLF, 'g'), constants.NOT_CRLF));
        } else if (fileDataString.indexOf(constants.NOT_CRLF)) {
            otherPlatformSha1 = getSha1FromData(fileDataString.replace(new RegExp(constants.NOT_CRLF, 'g'), constants.CRLF));
        }
    }
    return {sha1: sha1, otherPlatformSha1: otherPlatformSha1};
}
exports.getSha1 = getSha1;

function getSha1FromData(bufferData) {
    var shasum = crypto.createHash('sha1');
    shasum.update(bufferData);
    return shasum.digest('hex');
}

function getFileSizeInBytes(filePath) {
    var stats = fs.statSync(filePath);
    return stats["size"];
}

function calculateJavaScriptHashes(filePath) {
    //TODO Add try & catch
    var fileData = fs.readFileSync(filePath, {encoding: constants.UTF_8});
    return getJavaScriptHashes(converter.UTF8.stringToBytes(fileData));
}

function getJavaScriptHashes(arrayOfBytes) {

}