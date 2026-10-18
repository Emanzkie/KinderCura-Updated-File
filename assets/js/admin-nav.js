/**
 * admin-nav.js — Navigation utilities for the KinderCura Admin Dashboard
 * Auto-highlights the current nav link and provides nav helper functions.
 */

(function () {
  'use strict';

  /**
   * Highlights the nav-link whose href matches the current page path.
   * Handles both clean URLs (/admin/prc-verification) and full filenames
   * (/admin/admin-prc-verification.html) by comparing page identifiers.
   */
  function highlightCurrentNav() {
    var currentUrl = window.location.pathname.toLowerCase();
    var currentPage = currentUrl.split('/').pop().replace('.html', '');

    /* Extract base page name for clean URLs like /admin/prc-verification */
    var currentClean = currentPage;
    if (currentClean.startsWith('admin-')) {
      currentClean = currentClean.replace('admin-', '');
    }

    document.querySelectorAll('.main-nav .nav-link').forEach(function (link) {
      var linkHref = link.getAttribute('href');
      if (!linkHref) return;
      var linkPage = linkHref.split('/').pop().replace('.html', '');
      var linkClean = linkPage;
      if (linkClean.startsWith('admin-')) {
        linkClean = linkClean.replace('admin-', '');
      }

      var isMatch = (linkPage === currentPage) || (linkClean === currentClean) || (linkHref === currentUrl);
      if (isMatch) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  /**
   * Ensures the "PRC Verification" nav link exists.
   * If missing from the current page's nav, it injects it after the Users link.
   */
  function ensurePrcNavLink() {
    var nav = document.querySelector('.main-nav');
    if (!nav) return;
    var existing = nav.querySelector('a[href*="prc-verification"]');
    if (existing) return;

    var usersLink = nav.querySelector('a[href*="users"]');
    if (!usersLink) return;

    var prcLink = document.createElement('a');
    prcLink.href = '/admin/prc-verification';
    prcLink.className = 'nav-link';
    prcLink.textContent = 'PRC Verification';
    usersLink.parentNode.insertBefore(prcLink, usersLink.nextSibling);
  }

  /**
   * Ensures the "Question Origin" nav link exists on every admin page.
   * Injected here rather than hardcoded into each page so all admin pages stay
   * consistent without editing eight files.
   * Placed after Training, which is the closest related reporting page.
   *
   * Labelled "Question Origin", not "Data Sources": the page reports where a
   * QUESTION came from (Core Question Bank / Pediatrician Entry). Assessment
   * answers and ML training datasets are separate concepts — training datasets
   * are the Training page. See constants/dataOrigin.js.
   */
  function ensureDataSourcesNavLink() {
    var nav = document.querySelector('.main-nav');
    if (!nav) return;
    if (nav.querySelector('a[href*="data-sources"]')) return;

    var link = document.createElement('a');
    link.href = '/admin/admin-data-sources.html';
    link.className = 'nav-link';
    link.textContent = 'Question Origin';

    var anchor = nav.querySelector('a[href*="training"]') || nav.querySelector('a[href*="analytics"]');
    if (anchor) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      nav.appendChild(link);
    }
  }

  /**
   * Ensures the "Insights" nav link exists on every admin page.
   * Injected here rather than hardcoded into each page, for the same reason as
   * Data Sources above: nine admin pages each carry their own copy of the nav.
   *
   * Placed immediately after Reports, which is the closest related page. Note
   * these are two different pages and neither replaces the other — Reports is
   * the printable summary snapshot, Insights is the filtered analytical view.
   */
  function ensureInsightsNavLink() {
    var nav = document.querySelector('.main-nav');
    if (!nav) return;
    if (nav.querySelector('a[href*="admin-insights"]')) return;

    var link = document.createElement('a');
    link.href = '/admin/admin-insights.html';
    link.className = 'nav-link';
    link.textContent = 'Insights';

    var anchor = nav.querySelector('a[href*="admin-reports"]') || nav.querySelector('a[href*="analytics"]');
    if (anchor) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      nav.appendChild(link);
    }
  }

  /**
   * Keeps the bar to six primary modules. Insights, Payments and Question
   * Origin move (same nodes, same hrefs) into a dropdown opened by a chevron
   * right after Reports. Below 1024px admin-responsive.css flattens the group,
   * so the drawer still lists them as ordinary rows.
   */
  function buildMoreMenu() {
    var nav = document.querySelector('.main-nav');
    if (!nav || nav.querySelector('.nav-more')) return;

    var links = [
      nav.querySelector('a[href*="admin-insights"]'),
      nav.querySelector('a[href$="/admin/payments"]'),
      nav.querySelector('a[href*="data-sources"]')
    ].filter(Boolean);
    if (!links.length) return;

    var group = document.createElement('div');
    group.className = 'nav-more';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-more-toggle';
    toggle.setAttribute('aria-label', 'More modules');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'adminNavMore');

    var menu = document.createElement('div');
    menu.className = 'nav-more-menu';
    menu.id = 'adminNavMore';
    links.forEach(function (link) { menu.appendChild(link); });

    group.appendChild(toggle);
    group.appendChild(menu);

    var reports = nav.querySelector('a[href*="admin-reports"]');
    if (reports) {
      reports.parentNode.insertBefore(group, reports.nextSibling);
    } else {
      nav.appendChild(group);
    }

    function setOpen(open) {
      group.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function () {
      setOpen(!group.classList.contains('open'));
    });
    document.addEventListener('click', function (event) {
      if (!group.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if ((event.key === 'Escape' || event.key === 'Esc') && group.classList.contains('open')) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /**
   * Settings is reached from the profile menu, not the bar. Most admin pages
   * already carry the menu item; add it where a page's menu lacks it.
   */
  function moveSettingsToProfileMenu() {
    var navSettings = document.querySelector('.main-nav a[href*="admin-settings"]');
    if (navSettings) navSettings.remove();

    var menu = document.getElementById('profileMenu');
    if (!menu || menu.querySelector('a[href*="admin-settings"]')) return;

    var item = document.createElement('a');
    item.href = '/admin/admin-settings.html';
    item.className = 'menu-item';
    item.innerHTML = '<img src="/icons/settings.png" class="menu-icon">Settings';

    var before = menu.querySelector('hr') || menu.querySelector('.logout');
    menu.insertBefore(item, before);
  }

  /**
   * Run on DOMContentLoaded. Inject first, then highlight, so an injected link
   * is still eligible to be marked active on its own page.
   */
  function initAdminNav() {
    ensureDataSourcesNavLink();
    ensureInsightsNavLink();
    moveSettingsToProfileMenu();
    buildMoreMenu();
    highlightCurrentNav();

    // The chevron carries the active indicator when the current page is
    // one of the modules folded into the dropdown.
    var more = document.querySelector('.main-nav .nav-more');
    if (more && more.querySelector('.nav-link.active')) more.classList.add('has-active');

    markSettingsActive();
  }

  /**
   * Settings is no longer in the bar, so on the Settings page the current
   * location is shown on the profile button and on the Settings item inside
   * the profile menu instead.
   */
  function markSettingsActive() {
    if (window.location.pathname.toLowerCase().indexOf('admin-settings') === -1) return;
    var menu = document.getElementById('profileMenu');
    if (!menu) return;

    var items = Array.prototype.slice.call(menu.querySelectorAll('a[href*="admin-settings"]'));
    var item = items.filter(function (a) { return a.textContent.trim() === 'Settings'; })[0] || items[0];
    if (item) {
      item.classList.add('active');
      item.setAttribute('aria-current', 'page');
    }

    var button = document.querySelector('.nav-right .profile-btn');
    if (button) button.classList.add('has-active');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdminNav);
  } else {
    initAdminNav();
  }

  // Export helpers for external use
  window.adminNav = {
    highlightCurrentNav: highlightCurrentNav,
    ensurePrcNavLink: ensurePrcNavLink,
    ensureDataSourcesNavLink: ensureDataSourcesNavLink,
    ensureInsightsNavLink: ensureInsightsNavLink
  };

})();
