// === Extracted from SIGN-UP,LOGIN\landing.html (script block 1) ===
// Important: custom smooth scrolling with header offset so section titles stay visible.
        document.querySelectorAll('.header-nav a[href^="#"]').forEach((link) => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                const target = document.querySelector(link.getAttribute('href'));
                const header = document.querySelector('.landing-header');
                if (!target) return;

                const headerHeight = header ? header.offsetHeight : 0;
                const targetTop = target.getBoundingClientRect().top + window.pageYOffset - headerHeight - 20;

                window.scrollTo({
                    top: targetTop,
                    behavior: 'smooth'
                });
            });
        });


// === Mobile navigation ===
// Below the 900px breakpoint in landing-styles.css the nav links and the
// Login/Sign Up buttons live in #primaryNav, a drop-down panel under the sticky
// header. Above it the panel is display:contents and this code is inert, so the
// desktop header behaves exactly as before.
(function initMobileNav() {
    const toggle = document.getElementById('navToggle');
    const panel = document.getElementById('primaryNav');
    if (!toggle || !panel) return;

    // Must match the max-width of the hamburger media query.
    const MOBILE_QUERY = window.matchMedia('(max-width: 900px)');

    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

    function setOpen(open) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
        panel.classList.toggle('is-open', open);
    }

    toggle.addEventListener('click', () => setOpen(!isOpen()));

    // Tapping any item inside the panel closes it, so the destination section or
    // page is not hidden behind the menu.
    panel.addEventListener('click', (event) => {
        if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) {
            setOpen(false);
            toggle.focus();
        }
    });

    // Tapping the page outside the header closes the panel.
    document.addEventListener('click', (event) => {
        if (!isOpen()) return;
        if (event.target.closest('.landing-header')) return;
        setOpen(false);
    });

    // Rotating to landscape / widening past the breakpoint must not leave the
    // panel flagged open, or it would reappear on the next narrow layout.
    const onBreakpointChange = () => {
        if (!MOBILE_QUERY.matches) setOpen(false);
    };
    if (typeof MOBILE_QUERY.addEventListener === 'function') {
        MOBILE_QUERY.addEventListener('change', onBreakpointChange);
    } else if (typeof MOBILE_QUERY.addListener === 'function') {
        MOBILE_QUERY.addListener(onBreakpointChange);   // older Safari
    }
})();
