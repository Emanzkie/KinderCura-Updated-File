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
   * Run on DOMContentLoaded. Inject first, then highlight, so an injected link
   * is still eligible to be marked active on its own page.
   */
  function initAdminNav() {
    ensureDataSourcesNavLink();
    ensureInsightsNavLink();
    highlightCurrentNav();
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
