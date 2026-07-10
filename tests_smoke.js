const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/claude/returnshield/dashboard/index.html', 'utf8');
const errors = [];

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost:3000/',
  beforeParse(window) {
    window.addEventListener('error', e => errors.push('window error: ' + e.message));
    window.HTMLCanvasElement.prototype.getContext = function () {
      const noop = () => {};
      return new Proxy({
        drawImage: noop,
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(128) }),
        createLinearGradient: () => ({ addColorStop: noop }),
      }, {
        get: (t, prop) => (prop in t ? t[prop] : noop),
        set: () => true,
      });
    };
    window.requestAnimationFrame = cb => setTimeout(() => cb(window.performance.now()), 16);
  },
});

const { window } = dom;
const { document } = window;
const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));

setTimeout(() => {
  try {
    const assert = (cond, name) => {
      if (cond) console.log('PASS:', name);
      else { console.log('FAIL:', name); errors.push(name); }
    };

    // ============ LOGIN ============
    assert(!document.body.classList.contains('authed'), 'app starts locked at login');
    // wrong password
    document.getElementById('login-email').value = 'admin@returnshield.ai';
    document.getElementById('login-password').value = 'wrong';
    click(document.getElementById('login-btn'));
    assert(document.getElementById('login-error').textContent.includes('Invalid'), 'wrong password rejected');
    // company login
    document.getElementById('login-password').value = 'admin123';
    click(document.getElementById('login-btn'));
    assert(document.body.classList.contains('authed'), 'company login succeeds');
    assert(document.getElementById('user-chip').textContent.includes('company'), 'company role shown in header');

    // ============ COMPANY DASHBOARD ============
    assert(document.querySelectorAll('.case-row').length === 150, 'queue renders 150 cases');
    assert(document.getElementById('kpi-model').textContent === 'Random Forest', 'best model KPI shown');
    assert(document.querySelectorAll('#model-table tbody tr').length === 4, 'model table has 4 rows');
    click(document.querySelector('.case-row'));
    assert(document.querySelector('.fraud-gauge'), 'detail panel renders');
    document.getElementById('comment-text').value = 'Verified - escalating';
    click(document.getElementById('comment-submit'));
    assert(document.querySelectorAll('.comment-item').length === 1, 'comment workflow works');
    click(document.getElementById('simulate-btn'));
    assert(document.querySelectorAll('.case-row').length === 151, 'simulate adds a case');

    // transcript analyzer
    document.getElementById('transcript-input').value = 'it never arrived but tracking says delivered, refund right now';
    click(document.getElementById('analyze-transcript-btn'));
    assert(document.getElementById('transcript-result').textContent.includes('Contradiction'), 'transcript analyzer works');

    // invoice panel
    document.getElementById('inv-amount').value = '2000';
    document.getElementById('inv-order-amount').value = '1000';
    click(document.getElementById('verify-invoice-btn'));
    assert(document.getElementById('invoice-result').textContent.includes('differs'), 'company invoice verification works');

    // ============ CUSTOMER PORTAL (as company preview via tab) ============
    click(document.getElementById('tab-customer'));
    assert(document.body.classList.contains('customer-mode'), 'switch to customer view');

    // Log out and back in as CUSTOMER
    click(document.getElementById('logout-btn'));
    assert(!document.body.classList.contains('authed'), 'logout works');
    document.getElementById('login-email').value = 'customer@demo.com';
    document.getElementById('login-password').value = 'customer123';
    click(document.getElementById('login-btn'));
    assert(document.body.classList.contains('authed'), 'customer login succeeds');
    assert(document.getElementById('view-switch-wrap').style.display === 'none', 'customer cannot see view tabs');
    assert(document.body.classList.contains('customer-mode'), 'customer lands on portal');

    // order history renders
    assert(document.querySelectorAll('.order-select-card').length === 5, 'customer sees 5 orders in history');
    assert(document.getElementById('order-picker').textContent.includes('Nike Air Max'), 'Nike order in history');

    // ============ NIKE → PUMA DENIAL ============
    // Select the Nike order
    const nikeCard = Array.from(document.querySelectorAll('.order-select-card')).find(c => c.textContent.includes('Nike'));
    click(nikeCard);
    assert(document.querySelector('.order-select-card.selected'), 'order selected');
    // Declare returning a PUMA item
    document.getElementById('p-item-returned').value = 'Puma RS-X sneakers';
    document.getElementById('p-reason').value = 'Changed my mind';
    click(document.getElementById('p-submit-btn'));
    const denial = document.getElementById('portal-status').textContent;
    assert(denial.includes("can't accept this return"), 'Nike order + Puma return = DENIED');
    assert(denial.includes('Nike Air Max'), 'denial names the ordered product');
    assert(!denial.toLowerCase().includes('fraud'), 'denial avoids fraud language to customer');

    // Submit-without-order validation on fresh form
    click(Array.from(document.querySelectorAll('#portal-status button')).find(b => b.textContent.includes('another')));
    click(document.getElementById('p-submit-btn'));
    assert(document.getElementById('p-match-result').textContent.includes('select which order'), 'submission requires order selection');

    // ============ CLEAN RETURN APPROVED ============
    const levisCard = Array.from(document.querySelectorAll('.order-select-card')).find(c => c.textContent.includes("Levi's"));
    click(levisCard);
    document.getElementById('p-item-returned').value = "Levi's 501 jeans";
    document.getElementById('p-reason').value = 'Changed my mind';
    document.getElementById('p-description').value = 'Did not fit, sorry!';
    click(document.getElementById('p-submit-btn'));
    assert(document.getElementById('portal-status').textContent.includes('approved'), 'matching-product clean return approved');

    // ============ COMPANY SEES THE FRAUD CASE ============
    click(document.getElementById('logout-btn'));
    document.getElementById('login-email').value = 'admin@returnshield.ai';
    document.getElementById('login-password').value = 'admin123';
    click(document.getElementById('login-btn'));
    const rows = Array.from(document.querySelectorAll('.case-row'));
    const custRow = rows.find(r => r.textContent.includes('RET-CUST-0001'));
    assert(custRow, 'customer mismatch case visible to company');
    click(custRow);
    const detail = document.getElementById('detail-panel').textContent;
    assert(detail.includes('PRODUCT MISMATCH'), 'company sees PRODUCT MISMATCH flag');
    assert(detail.includes('PUMA') && detail.includes('Nike'), 'company sees Puma-vs-Nike evidence');
    assert(detail.includes('does not match the ordered product'), 'company sees reject recommendation');
    assert(custRow.querySelector('.risk-chip.HIGH'), 'mismatch case marked HIGH risk');


    // ============ ROLE ENFORCEMENT (hard) ============
    click(document.getElementById('logout-btn'));
    document.getElementById('login-email').value = 'customer@demo.com';
    document.getElementById('login-password').value = 'customer123';
    click(document.getElementById('login-btn'));
    assert(document.body.classList.contains('role-customer'), 'role-customer class applied');
    // even if a hostile script forces setView('company'), guard keeps customer view
    window.eval("setView('company')");
    assert(document.body.classList.contains('customer-mode'), 'setView(company) blocked for customer role');
    const compView = document.getElementById('company-view');
    assert(window.getComputedStyle(compView).display === 'none', 'company view hard-hidden via CSS for customer role');

    // ============ MY RETURNS TRACKER ============
    // customer already has submissions from earlier tests in myReturns? new session per login persists in-page. Submit one now:
    const nike2 = Array.from(document.querySelectorAll('.order-select-card')).find(c => c.textContent.includes('Adidas'));
    click(nike2);
    document.getElementById('p-item-returned').value = 'Adidas Ultraboost';
    document.getElementById('p-reason').value = 'Item not as described';
    document.getElementById('p-description').value = 'Color looked different online';
    click(document.getElementById('p-submit-btn'));
    assert(document.getElementById('my-returns-card').style.display !== 'none', 'My Returns card visible after submit');
    assert(document.querySelectorAll('.my-returns-item').length >= 1, 'My Returns lists the submission');
    // filter my returns
    document.getElementById('my-returns-search').value = 'zzz-no-match';
    document.getElementById('my-returns-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert(document.getElementById('my-returns-list').textContent.includes('No returns match'), 'My Returns search filters');
    document.getElementById('my-returns-search').value = 'Adidas';
    document.getElementById('my-returns-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert(document.querySelectorAll('.my-returns-item').length >= 1, 'My Returns search finds Adidas');

    // ============ COMPANY QUEUE FILTERS ============
    click(document.getElementById('logout-btn'));
    document.getElementById('login-email').value = 'admin@returnshield.ai';
    document.getElementById('login-password').value = 'admin123';
    click(document.getElementById('login-btn'));
    // search filter
    document.getElementById('queue-search').value = 'RET-CUST';
    document.getElementById('queue-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    let visible = document.querySelectorAll('.case-row');
    assert(visible.length >= 1 && Array.from(visible).every(r => r.textContent.includes('RET-CUST')), 'queue search filters by ID');
    // customer-only chip
    document.getElementById('queue-search').value = '';
    document.getElementById('queue-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    click(document.querySelector('.filter-chip[data-source="customer"]'));
    visible = document.querySelectorAll('.case-row');
    assert(Array.from(visible).every(r => r.querySelector('.source-tag')), 'customer-only chip filters to customer submissions');
    click(document.querySelector('.filter-chip[data-source="customer"]'));
    // high-risk chip
    click(document.querySelector('.filter-chip[data-tier="HIGH"]'));
    visible = document.querySelectorAll('.case-row');
    assert(Array.from(visible).every(r => r.querySelector('.risk-chip.HIGH')), 'HIGH chip filters to high-risk only');
    click(document.querySelector('.filter-chip[data-tier="ALL"]'));
    // no-results state
    document.getElementById('queue-search').value = 'zzzz-impossible-query';
    document.getElementById('queue-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert(document.getElementById('case-list').textContent.includes('No cases match'), 'no-results message shows');
    document.getElementById('queue-search').value = '';
    document.getElementById('queue-search').dispatchEvent(new window.Event('input', { bubbles: true }));

    // ============ STATUS SYNC: analyst decision -> customer tracker ============
    document.getElementById('queue-search').value = 'Adidas';
    document.getElementById('queue-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    const adidasRow = Array.from(document.querySelectorAll('.case-row')).find(r => r.textContent.includes('RET-CUST'));
    assert(adidasRow, 'company finds the Adidas customer case via search');
    click(adidasRow);
    document.getElementById('comment-text').value = 'Photos check out - approving.';
    document.getElementById('comment-action').value = 'approve';
    click(document.getElementById('comment-submit'));
    // back to customer: status should now read APPROVED
    click(document.getElementById('logout-btn'));
    document.getElementById('login-email').value = 'customer@demo.com';
    document.getElementById('login-password').value = 'customer123';
    click(document.getElementById('login-btn'));
    document.getElementById('my-returns-search').value = '';
    document.getElementById('my-returns-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    const tracker = document.getElementById('my-returns-list').textContent;
    assert(tracker.includes('APPROVED'), 'analyst approval synced to customer My Returns status');


    // ============ AGENT 7: X-RAY INTAKE — $1000 shoe, $30 substitute ============
    // (still logged in as customer from status-sync test — go back to company)
    click(document.getElementById('logout-btn'));
    document.getElementById('login-email').value = 'admin@returnshield.ai';
    document.getElementById('login-password').value = 'admin123';
    click(document.getElementById('login-btn'));

    const xsel = document.getElementById('xray-case-select');
    assert(xsel.querySelectorAll('option').length > 1, 'X-ray case selector populated');
    // pick the Nike/Puma customer fraud case (RET-CUST-0001)
    const nikeOpt = Array.from(xsel.querySelectorAll('option')).find(o => o.textContent.includes('Nike Air Max'));
    assert(nikeOpt, 'Nike customer case available at intake');
    xsel.value = nikeOpt.value;
    xsel.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert(document.getElementById('xray-expected').textContent.includes('1150 g'), 'catalog expected weight shown (1150g)');

    // scale reads 310g — a cheap substitute in a big shoe box
    document.getElementById('xray-weight').value = '310';
    document.getElementById('xray-weight').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert(document.getElementById('xray-dev-pct').textContent.includes('-73%'), 'weight deviation computed (-73%)');

    click(document.getElementById('xray-scan-btn'));

      // scan completes async (animation) — assertions run after delay
      setTimeout(() => {
        try {
          const xres = document.getElementById('xray-result').textContent;
          assert(xres.includes('CONTENTS MISMATCH'), 'X-ray verdict: CONTENTS MISMATCH');
          assert(xres.includes('item substitution'), 'substitution named in evidence');
          assert(document.getElementById('xray-apply-btn').style.display !== 'none', 'apply-to-case offered');
          click(document.getElementById('xray-apply-btn'));
          // clear any leftover queue filter so the selected row is visible
          document.getElementById('queue-search').value = '';
          document.getElementById('queue-search').dispatchEvent(new window.Event('input', { bubbles: true }));
          const applied = cases_probe();
          assert(applied.risk === 'HIGH' && applied.prob >= 95, 'case escalated to HIGH / 95%+ after intake');
          assert(applied.reasonsText.includes('WAREHOUSE INTAKE'), 'intake evidence prepended to case');
          assert(applied.recommendation.includes('Do not refund'), 'recommendation: do not refund');

          console.log('\n' + (errors.length ? `RESULT: ${errors.length} FAILURES` : 'RESULT: ALL TESTS PASSED'));
          window.close();
          process.exit(errors.length ? 1 : 0);
        } catch (e) {
          console.log('XRAY TEST CRASH:', e.message);
          process.exit(1);
        }
      }, 2600);
      function cases_probe() {
        const detail = document.getElementById('detail-panel').textContent;
        const row = Array.from(document.querySelectorAll('.case-row')).find(r => r.classList.contains('selected'));
        return {
          risk: row && row.querySelector('.risk-chip') ? row.querySelector('.risk-chip').textContent : '',
          prob: row ? parseFloat(row.querySelector('.case-prob').textContent) : 0,
          reasonsText: detail,
          recommendation: detail,
        };
      }
      return; // async path takes over; skip synchronous epilogue
    console.log('\n' + (errors.length ? `RESULT: ${errors.length} FAILURES` : 'RESULT: ALL TESTS PASSED'));
  } catch (e) {
    console.log('TEST CRASH:', e.message, e.stack.split('\n')[1]);
    errors.push('crash');
  }
  window.close();
  process.exit(errors.length ? 1 : 0);
}, 1500);
