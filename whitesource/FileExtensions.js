/**
 * @author raz.nitzan
 */

var FileExtensionsConstants = require("./FileExtensionsConstants");

function buildBinaryRegex() {
    var result = "";
    result = result + buildRegexString(FileExtensionsConstants.GENERIC_RESOURCE_FILE_EXTENSIONS);
    result = result + FileExtensionsConstants.OR_REGEX;
    result = result + buildRegexString(FileExtensionsConstants.JAVA_FILE_EXTENSIONS);
    result = result + FileExtensionsConstants.OR_REGEX;
    result = result + buildRegexString(FileExtensionsConstants.DOT_NET_FILE_EXTENSIONS);
    return new RegExp(result);
}

exports.buildBinaryRegex = buildBinaryRegex;

function buildRegexString(extensions) {
    var result = "";
    for(var extension in extensions) {
        result = result + FileExtensionsConstants.FILE_EXTENSION_PREFIX_REGEX + extensions[extension] + FileExtensionsConstants.OR_REGEX;
    }
    return result.substr(0, result.length - 1);
}