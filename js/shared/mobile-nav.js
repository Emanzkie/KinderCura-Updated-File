/* mobile-nav.js — hamburger toggle for the collapsed top navigation.
 *
 * Only ever touches the header: it adds/removes `nav-open` on
 * `.top-nav.has-mobile-nav`, which is the single hook parent-responsive.css
 * uses to show the dropdown panel below 1024px. Above that breakpoint the
 * class is inert, so the desktop bar is unaffected whether it is set or not.
 *
 * Deliberately independent of api.js: it registers no globals and does not
 * interfere with toggleProfileMenu()/openNotifications(), which keep owning
 * the profile menu and the notifications modal.
 */
(function () {
    'use strict';

    var DESKTOP_QUERY = '(min-width: 1025px)';

    function init() {
        var header = document.querySelector('.top-nav.has-mobile-nav');
        if (!header) return;

        var toggle = header.querySelector('.nav-toggle');
        var nav = header.querySelector('.main-nav');
        if (!toggle || !nav) return;

        if (!nav.id) nav.id = 'primaryNav';
        toggle.setAttribute('aria-controls', nav.id);

        function setOpen(open) {
            header.classList.toggle('nav-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
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
