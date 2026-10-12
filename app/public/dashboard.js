// Web member app: the shared core (member-core.js) in the web shell —
// left rail on desktop, bottom tabs on phones. LIFF mounts the same core.
import { session, logout } from '/site.js';
import { mountMemberApp } from '/member-core.js';

if (!session.loggedIn) location.replace('/start.html');
else {
  mountMemberApp(document.getElementById('app'), {
    platform: 'web',
    onAuthFail: () => { session.token = null; location.replace('/start.html'); },
    onLogout: logout,
  });
}
