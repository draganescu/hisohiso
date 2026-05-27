// hisohiso launch — tiny progressive enhancement. No dependencies.
// With JS off: the copy button is inert, the default bridge panel is readable,
// the ciphertext sits still, and every section is fully visible.
(function () {
  "use strict";

  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Responsive nav ----
     Markup ships with the links visible; only when this runs do we opt into the
     collapsed hamburger behaviour, so a failed/disabled script leaves nav usable. */
  var navToggle = document.querySelector(".nav-toggle");
  var topnav = document.getElementById("topnav");
  if (navToggle && topnav) {
    document.body.classList.add("js-nav");

    var setNav = function (open) {
      topnav.classList.toggle("is-open", open);
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };

    navToggle.addEventListener("click", function () {
      setNav(navToggle.getAttribute("aria-expanded") !== "true");
    });

    // Picking a destination closes the menu.
    topnav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setNav(false);
    });

    // Escape closes and returns focus to the toggle.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
        setNav(false);
        navToggle.focus();
      }
    });

    // A tap anywhere outside the bar dismisses an open menu.
    document.addEventListener("click", function (e) {
      if (
        navToggle.getAttribute("aria-expanded") === "true" &&
        !e.target.closest(".topbar")
      ) {
        setNav(false);
      }
    });
  }

  /* ---- Copy-to-clipboard for the install command ---- */
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetId = btn.getAttribute("data-copy-target");
      var el = targetId && document.getElementById(targetId);
      if (!el) return;
      var text = el.textContent.trim();

      var done = function () {
        var original = btn.textContent;
        btn.textContent = "Copied";
        btn.setAttribute("data-copied", "true");
        setTimeout(function () {
          btn.textContent = original;
          btn.removeAttribute("data-copied");
        }, 1600);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }

      function fallbackCopy() {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          done();
        } catch (e) {
          /* clipboard unavailable — leave the command visible to copy by hand */
        }
      }
    });
  });

  /* ---- Bridge mode tabs (wrap / daemon) ---- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".mode-tab"));
  if (tabs.length) {
    function selectTab(tab, focusIt) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.tabIndex = selected ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      });
      if (focusIt) tab.focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        selectTab(tab, false);
      });
      // Arrow-key navigation between tabs for keyboard users.
      tab.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var next =
          e.key === "ArrowRight"
            ? (i + 1) % tabs.length
            : (i - 1 + tabs.length) % tabs.length;
        selectTab(tabs[next], true);
      });
    });
  }

  /* ---- The wire: ciphertext that never settles ----
     The plaintext on either end stays put; only the middle churns, so the
     "server can't read this" claim is visible, not just stated. */
  var cipherEl = document.querySelector("[data-cipher]");
  if (cipherEl && !reduceMotion) {
    var GLYPHS = "0123456789abcdef0123456789ABCDEF▓▒░".split("");
    var chars = cipherEl.textContent.split("");
    var timer = null;

    function scramble() {
      // Repaint a handful of positions each tick — flowing, not strobing.
      for (var n = 0; n < 3; n++) {
        var i = (Math.random() * chars.length) | 0;
        chars[i] = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      cipherEl.textContent = chars.join("");
    }

    function start() {
      if (!timer) timer = setInterval(scramble, 90);
    }
    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    // Be a good citizen: don't churn while the tab is hidden.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stop();
      else start();
    });
    start();
  }

  /* ---- Scroll reveal ----
     Opt-in only when motion is welcome; otherwise the page is static and whole.
     The hidden state is applied via the .js-reveal body class, so a failed or
     disabled script leaves everything visible. */
  if (!reduceMotion && "IntersectionObserver" in window) {
    var blocks = Array.prototype.slice.call(
      document.querySelectorAll(".page > section")
    );
    if (blocks.length) {
      document.body.classList.add("js-reveal");
      blocks.forEach(function (b) {
        b.classList.add("reveal");
      });
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              io.unobserve(entry.target);
            }
          });
        },
        { rootMargin: "0px 0px -10% 0px", threshold: 0.08 }
      );
      blocks.forEach(function (b) {
        io.observe(b);
      });
    }
  }
})();
