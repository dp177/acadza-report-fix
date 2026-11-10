import DOMPurify from 'dompurify'

// Question content is untrusted HTML + MathML straight from the dataset.
// Sanitize with html+mathMl profiles: strips scripts, event handlers,
// iframes and unsafe URLs; keeps formatting and native MathML rendering.
export function sanitizeContentHtml(dirty) {
  return DOMPurify.sanitize(dirty || '', {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select',
      'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['srcset', 'formaction', 'srcdoc'],
  })
}
