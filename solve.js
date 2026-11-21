// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what
// csv-reader returns for {text, header} — {columns, rows, errors} — but
// reads the text with indexOf scans and slice instead of one character at
// a time. The broken-row policy is csv-reader's own, reproduced exactly:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, each CRLF or lone CR inside it read
//     as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false), each
//     padded with "" (short_row, with fields: its count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field counted),
//     row its record's index in rows (null for the header), in the order
//     met, a field's quote_junk when the field ends and a record's
//     short_row or long_row when the record ends.
//
// Speed comes from three shortcuts, each taken only when it cannot change
// the answer: a line with no quote and no CR is split(',') in one call; an
// unquoted field is found by the nearest of ',', LF and CR via indexOf
// rather than scanned; a quoted field is found by indexOf('"'), and its
// content is sliced as-is unless it holds a CR (only then is CRLF/lone CR
// rewritten to LF) or a doubled quote.

const COMMA = 1;
const BREAK = 2;
const END = 3;
const CR_DELIM = 4;

const CR = 13;
const LF = 10;
const QUOTE = 34;
const COMMA_CODE = 44;
const BOM = 0xfeff;

/** Count LF characters in s (indexOf loop; s is usually short). */
function countLf(s) {
  let count = 0;
  let i = s.indexOf('\n');
  while (i !== -1) {
    count += 1;
    i = s.indexOf('\n', i + 1);
  }
  return count;
}

/** csv-reader 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === BOM) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Field results travel in these three slots instead of a fresh array per
  // field, to keep the hot path allocation-free.
  let fieldValue = '';
  let fieldEnded = END;
  let fieldAdded = 0;

  // Reads an unquoted field starting at pos, appending onto `value`.
  // Sets fieldValue, fieldEnded (COMMA, BREAK or END) and fieldAdded (the
  // characters appended; stray CRs dropped along the way are not counted).
  // Stray CRs push their errors as they are met.
  function readUnquoted(value) {
    let added = 0;
    let parts = null;
    let start = pos;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let cut = n;
      let kind = END;
      if (comma !== -1 && comma < cut) { cut = comma; kind = COMMA; }
      if (lf !== -1 && lf < cut) { cut = lf; kind = BREAK; }
      if (cr !== -1 && cr < cut) { cut = cr; kind = CR_DELIM; }
      if (kind === CR_DELIM) {
        // A CR: CRLF ends the record, a lone CR is dropped (stray_cr) and
        // the field goes on.
        if (text.charCodeAt(cut + 1) === LF) {
          if (parts !== null) {
            parts.push(text.slice(start, cut));
            value += parts.join('');
          } else if (cut > start) {
            value += text.slice(start, cut);
          }
          added += cut - start;
          pos = cut + 2;
          line += 1;
          fieldValue = value;
          fieldEnded = BREAK;
          fieldAdded = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(start, cut));
        added += cut - start;
        pos = cut + 1;
        start = pos;
        continue;
      }
      if (parts !== null) {
        parts.push(text.slice(start, cut));
        value += parts.join('');
      } else if (cut > start) {
        value += text.slice(start, cut);
      }
      added += cut - start;
      fieldValue = value;
      fieldAdded = added;
      if (kind === COMMA) {
        pos = cut + 1;
        fieldEnded = COMMA;
        return;
      }
      if (kind === BREAK) {
        pos = cut + 1;
        line += 1;
        fieldEnded = BREAK;
        return;
      }
      pos = n;
      fieldEnded = END;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fieldValue
  // and fieldEnded. The closing quote is found by indexOf; a quote that
  // never closes falls back to the unquoted read, exactly as csv-reader
  // does (the line count of the failed scan is discarded, since nothing
  // was counted while looking for the closing quote).
  function readQuoted() {
    const open = pos;
    let search = pos + 1;
    let contentStart = pos + 1;
    let parts = null;
    let closed = -1;
    for (;;) {
      const q = text.indexOf('"', search);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === QUOTE) {
        if (parts === null) parts = [];
        parts.push(text.slice(contentStart, q), '"');
        search = q + 2;
        contentStart = q + 2;
        continue;
      }
      closed = q;
      break;
    }
    if (closed === -1) {
      pos = open + 1;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    let value;
    if (parts === null) {
      value = text.slice(contentStart, closed);
    } else {
      parts.push(text.slice(contentStart, closed));
      value = parts.join('');
    }
    // Newlines inside quotes count lines, and CRs become LF. A CRLF, a
    // lone CR and a lone LF each count once — so after rewriting CRs to LF,
    // the line count is the LF count of the rewritten content.
    if (value.indexOf('\r') !== -1) {
      value = value.replace(/\r\n?/g, '\n');
      line += countLf(value);
    } else if (value.indexOf('\n') !== -1) {
      line += countLf(value);
    }
    pos = closed + 1;
    if (pos >= n) {
      fieldValue = value;
      fieldEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA_CODE) {
      pos += 1;
      fieldValue = value;
      fieldEnded = COMMA;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      fieldValue = value;
      fieldEnded = BREAK;
      return;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      fieldValue = value;
      fieldEnded = BREAK;
      return;
    }
    readUnquoted(value);
    if (fieldAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record is one line with no quote and no CR, so no
    // field can span lines and no CR can be stray — split it in one call.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    let contentEnd = lineEnd;
    // A CR right before the LF is half of a CRLF, not content — but only
    // when there is an LF: a CR at the very end of the text is stray.
    if (lf !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === CR) contentEnd -= 1;
    const qAt = text.indexOf('"', pos);
    const crAt = text.indexOf('\r', pos);
    const hasQuote = qAt !== -1 && qAt < contentEnd;
    const hasCr = crAt !== -1 && crAt < contentEnd;
    if (!hasQuote && !hasCr) {
      const fields = contentEnd === pos ? [''] : text.slice(pos, contentEnd).split(',');
      if (lf === -1) {
        pos = n;
      } else {
        pos = lf + 1;
        line += 1;
      }
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // Slow path: field by field.
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      if (quoted) {
        readQuoted();
      } else {
        readUnquoted('');
      }
      fields.push(fieldValue);
      ended = fieldEnded;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
