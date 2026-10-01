/* mobile-nav.js — hamburger toggle for the collapsed top navigation.
 *
 * Only ever touches the header: it adds/removes `nav-open` on
 * `.top-nav.has-mobile-nav`, which is the single hook mobile-nav.css uses to
 * show the dropdown panel below 1024px. Above that breakpoint the class is
 * inert, so the desktop bar is unaffected whether it is set or not.
 *
 * Deliberately independent of api.js: it registers no globals and does not
 * interfere with toggleProfileMenu()/openNotifications(), which keep owning
 * the profile menu and the notifications modal.
 *
 * A header that also carries `.nav-drawer` (the parent side does, via
 * parent-mobile-nav.css) gets two extras, both purely presentational:
 * an identity row at the top of the panel and a Log Out row at the bottom.
 * Neither adds a route or a request — the Log Out row forwards the click to
 * the header's own `a.logout`, so whichever page script bound that link keeps
 * owning the sign-out. Headers without the class are unaffected.
 * It also builds the panel's profile block (avatar, name, role). That block
 * is identical on the PARENT and PEDIA sides and has to be filled from the
 * signed-in user either way, so building it once here beats repeating six
 * lines of markup across the twenty pages that load this file.
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

    function buildIdentity(header, nav) {
        // Parent and pedia headers id the avatar; the secretary header does not,
        // so fall back to the image inside the profile button. The greeting is
        // whichever element api.js writes the name into on that role's pages.
        var sourcePic = header.querySelector('#navProfilePic') ||
            header.querySelector('.profile-btn .profile-icon');
        var sourceName = header.querySelector('#navWelcome, .menu-header p');

        // A link only when the header names a profile page; otherwise the row
        // is a plain label, never a dead href.
        var profileHref = header.getAttribute('data-nav-profile');
        var link = document.createElement(profileHref ? 'a' : 'div');
        link.className = 'nav-drawer-identity';
        if (profileHref) link.href = profileHref;

        var avatar = document.createElement('img');
        avatar.className = 'nav-drawer-avatar';
        avatar.alt = '';
        avatar.setAttribute('aria-hidden', 'true');

        var who = document.createElement('span');
        who.className = 'nav-drawer-who';

        var name = document.createElement('span');
        name.className = 'nav-drawer-name';

        var role = document.createElement('span');
        role.className = 'nav-drawer-role';
        role.textContent = header.getAttribute('data-nav-role') || '';

        // Guardian Management has no profile menu, so there is no greeting to
        // mirror. Rather than show an empty line, the role becomes the label.
        if (!sourceName && role.textContent) {
            name.textContent = role.textContent;
            role.textContent = '';
        }

        who.appendChild(name);
        if (role.textContent) who.appendChild(role);
        link.appendChild(avatar);
        link.appendChild(who);
        nav.insertBefore(link, nav.firstChild);

        // The header's own avatar and greeting are filled in asynchronously by
        // api.js / the page script, so mirror them whenever they change rather
        // than reading them once at load.
        function sync() {
            if (sourcePic && sourcePic.src && avatar.src !== sourcePic.src) {
                avatar.src = sourcePic.src;
            }
            if (sourceName) {
                var text = (sourceName.textContent || '').replace(/^\s*welcome[,\s]*/i, '').trim();
                if (text && name.textContent !== text) name.textContent = text;
            }
        }
        sync();

        if (window.MutationObserver) {
            if (sourcePic) {
                new MutationObserver(sync).observe(sourcePic, {
                    attributes: true,
                    attributeFilter: ['src']
                });
            }
            if (sourceName) {
                new MutationObserver(sync).observe(sourceName, {
                    childList: true,
                    characterData: true,
                    subtree: true
                });
            }
        }
    }

    function buildLogout(header, nav) {
        var source = header.querySelector('a.logout');
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
            buildIdentity(header, nav);
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
