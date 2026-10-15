import re, glob, os
n = 0
for f in glob.glob('server/**/*.ts', recursive=True):
    if f.replace('\\', '/').endswith('server/lib/documentDates.ts'): continue
    s = open(f, encoding='utf-8', newline='').read()
    crlf = '\r\n' in s
    t = s.replace('\r\n', '\n')
    t2 = re.sub(r"docDate: ([^,\n]+(?:\([^)\n]*\))?[^,\n]*), postingDate: \1,", r"...documentDates(\1),", t)
    if t2 != t:
        # add the import
        rel = '../lib/documentDates.js' if '/routes/' in f.replace('\\', '/') else './documentDates.js'
        if 'documentDates.js' not in t2:
            # after the last top import line
            imps = [m for m in re.finditer(r"^import .*;$", t2, re.M)]
            pos = imps[-1].end()
            t2 = t2[:pos] + f"\nimport {{ documentDates }} from '{rel}';" + t2[pos:]
        open(f, 'w', encoding='utf-8', newline='').write(t2.replace('\n', '\r\n') if crlf else t2)
        n += 1; print(f)
print(n)
