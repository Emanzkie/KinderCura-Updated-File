/* mobile-nav.js — hamburger toggle for the collapsed top navigation.
 *
 * Only ever touches the header: it adds/removes `nav-open` on
 * `.top-nav.has-mobile-nav`, which is the single hook mobile-nav.css uses to
 * show the dropdown panel below 1024px. Above that breakpoint the class is
 * inert, so the desktop bar is unaffected whether it is set or not.
 *
 * A header that also carries `.nav-drawer` (the parent side does, via
 * parent-mobile-nav.css) gets one extra, purely presentational: a Log Out
 * row at the bottom of the panel. It adds no route and no request — the row
 * forwards the click to the header's own `a.logout`, so whichever page script
 * bound that link keeps owning the sign-out. Headers without the class are
 * unaffected.
 *
 * It also builds the panel's profile block (avatar, name, role) — the single
 * identity row the drawer shows, and the only one: it is built for every role,
 * so no second block is created for .nav-drawer headers. It has to be filled
 * from the signed-in user either way, so building it once here beats repeating
 * six lines of markup across the twenty pages that load this file.
 *
 * Deliberately independent of api.js: it registers no globals, reads the
 * cached user straight out of localStorage rather than calling apiFetch, and
 * does not interfere with toggleProfileMenu()/openNotifications(), which keep
 * owning the profile menu and the notifications modal. The avatar it creates
 * carries .profile-icon, the hook api.js already refreshes after /auth/me, so
 * a newly uploaded picture still lands here without a change there.
 */
(function () {
    'use strict';

    var DESKTOP_QUERY = '(min-width: 1025px)';

    /* ---------------------------------------------------------------------
     * Drawer chrome — only for .nav-drawer headers.
     * ------------------------------------------------------------------- */

    function buildLogout(header, nav) {
        // The panel may already carry a Log Out row in the markup (the parent
        // pages do; the secretary pages do not). That row predates the drawer:
        // it is a .nav-link, so the drawer gives it an icon box it has no rule
        // for — a hollow fallback dot — and a chevron that lands above the row
        // because the divider shifts its static position. The button built
        // below replaces it, so prefer a logout link from outside the panel as
        // the forwarding target and drop the row once the button is in place.
        var inPanel = nav.querySelector('a.logout.nav-logout');
        var source = header.querySelector('a.logout:not(.nav-logout)') || inPanel;
        if (!source) return;

        var divider = document.createElement('div');
        divider.className = 'nav-drawer-divider';

        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'nav-drawer-logout';
        button.textContent = 'Log Out';
        // Forwards to the existing link, so the page's own logout handler runs.
        button.addEventListener('click', function () {
            source.click();
        });

        nav.appendChild(divider);
        nav.appendChild(button);

        // The button above replaces that row, so it always comes out of the
        // panel. Guardian Management has no profile menu, so there the row is
        // also the forwarding target: detaching it keeps the click working,
        // because api.js bound the handler to the node itself (it runs on
        // DOMContentLoaded, before this file) and listeners survive removal.
        // The row was never more than that hook — its href is "#".
        if (inPanel) inPanel.remove();
    }

    // Mirrors the wording api.js uses for the profile dropdown greeting.
    function roleLabel(role) {
        if (!role) return '';
        return role.charAt(0).toUpperCase() + role.slice(1);
    }

    function cachedUser() {
        try {
            return JSON.parse(localStorage.getItem('kc_user'));
        } catch (err) {
            return null;
        }
    }

    function profileBlock(nav) {
        var block = nav.querySelector('.nav-profile');
        if (block) return block;

        block = document.createElement('div');
        block.className = 'nav-profile';
        // The name beside it is the accessible label, so the image is
        // decorative; .profile-icon keeps api.js refreshing its src.
        block.innerHTML =
            '<img class="nav-profile-pic profile-icon" src="/icons/profile.png" alt="" aria-hidden="true">' +
            '<div class="nav-profile-text">' +
            '<p class="nav-profile-name"></p>' +
            '<p class="nav-profile-role"></p>' +
            '</div>';
        nav.insertBefore(block, nav.firstChild);
        return block;
    }

    // Called on open as well as at init: api.js refreshes kc_user from
    // /auth/me asynchronously, so the first paint can predate the real name.
    function fillProfile(nav) {
        var user = cachedUser();
        if (!user) return;

        var block = profileBlock(nav);
        var name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        if (name && user.role === 'pediatrician') name = 'Dr. ' + name;

        block.querySelector('.nav-profile-name').textContent = name || user.username || 'Signed in';
        block.querySelector('.nav-profile-role').textContent = roleLabel(user.role);

        // Same rule api.js applies: only an uploaded file replaces the default.
        var uploaded = user.profileIcon && String(user.profileIcon).indexOf('/uploads/') === 0;
        if (uploaded) block.querySelector('.nav-profile-pic').src = user.profileIcon;
    }

    function init() {
        var header = document.querySelector('.top-nav.has-mobile-nav');
        if (!header) return;

        var toggle = header.querySelector('.nav-toggle');
        var nav = header.querySelector('.main-nav');
        if (!toggle || !nav) return;

        if (!nav.id) nav.id = 'primaryNav';
        toggle.setAttribute('aria-controls', nav.id);

        var isDrawer = header.classList.contains('nav-drawer');
        if (isDrawer) {
            buildLogout(header, nav);
        }
        fillProfile(nav);

        function setOpen(open) {
            if (open) fillProfile(nav);
            header.classList.toggle('nav-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
            // The drawer dims the page behind it, so that page must not
            // scroll away underneath. The class is a no-op above 1024px.
            if (isDrawer) document.body.classList.toggle('nav-drawer-open', open);
        }

        function close() {
            if (header.classList.contains('nav-open')) setOpen(false);
        }

        toggle.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(!header.classList.contains('nav-open'));
        });

        // Following a link closes the panel; the click itself still navigates.
        nav.addEventListener('click', function (event) {
            if (event.target.closest('a')) close();
        });

        // Tapping anywhere outside the panel closes it.
        document.addEventListener('click', function (event) {
            if (!header.classList.contains('nav-open')) return;
            if (event.target.closest('.main-nav') || event.target.closest('.nav-toggle')) return;
            close();
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' || event.key === 'Esc') close();
        });

        // Rotating a tablet back to desktop width must not leave the panel
        // open, or its absolute positioning would sit under the desktop bar.
        var desktop = window.matchMedia(DESKTOP_QUERY);
        var onBreakpointChange = function () {
            if (desktop.matches) close();
        };
        if (desktop.addEventListener) desktop.addEventListener('change', onBreakpointChange);
        else if (desktop.addListener) desktop.addListener(onBreakpointChange);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
