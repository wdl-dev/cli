/** @param {unknown} error */
export function isSecretEnvelopeErrorCode(error) {
  return error === "invalid_envelope" ||
    error === "secret_decrypt_failed" ||
    error === "secret_encryption_unconfigured" ||
    error === "secret_not_encrypted" ||
    error === "unsupported_envelope" ||
    error === "unknown_kid";
}
