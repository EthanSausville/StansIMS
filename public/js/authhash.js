// Runs before the app: remembers whether this visit came from an invite or a
// password-reset email, before the sign-in library reads and clears the link.
(function () {
  var p = new URLSearchParams(location.hash.slice(1));
  var q = new URLSearchParams(location.search);
  window.STANS_AUTH_TYPE = p.get('type') || q.get('type') || null;
  window.STANS_AUTH_ERROR = p.get('error_description') || q.get('error_description') || null;
})();
