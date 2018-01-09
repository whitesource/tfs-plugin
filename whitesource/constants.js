/**
 * @author raz.nitzan
 */
module.exports = Object.freeze({
    BUFFER_SIZE: 32 * 1024,
    FILE_MIN_SIZE_THRESHOLD: 512,
    FILE_PARTIAL_HASH_MIN_SIZE: 1024 * 2,
    FILE_SMALL_SIZE: 1024 * 3,
    FILE_SMALL_BUCKET_SIZE: 1024 * 1.25,
    CARRIAGE_RETURN: 13,
    NEW_LINE: 10,
    HORIZONTAL_TAB: 9,
    SPACE: 32,
    SEMICOLON: 59,
    WHITESPACE: [13, 10, 9, 32],
    UTF_8: "utf8",
    JS_SCRIPT_REGEX: /.*\.js/,
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    CRLF: "\r\n",
    NOT_CRLF: "\n"
});
