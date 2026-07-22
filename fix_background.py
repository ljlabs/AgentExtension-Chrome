import re

with open(r'c:\Users\jorda\Documents\workspace\AgentExtension\AgentExtension-Chrome\background.js', 'r') as f:
    content = f.read()

# Fix all the broken data: prefixes
# Pattern: { ok: true,  <something> } should be { ok: true,  <something> }
# The issue is the tool stripped the 'data' keyword

# Replace patterns where 'data' is missing after 'true,'
content = re.sub(
    r'\{ ok: true,  (\w)',
    lambda m: '{ ok: true,  ' + m.group(1),
    content
)

# Also fix the _images array patterns
content = content.replace('],  [', '],  [')
content = content.replace('],  dataUrl', '],  dataUrl')

# Fix the screenshot _images pattern
content = content.replace('[`' + '${mime};base64,${base64}`]', '[`${mime};base64,${base64}`]')

with open(r'c:\Users\jorda\Documents\workspace\AgentExtension\AgentExtension-Chrome\background.js', 'w') as f:
    f.write(content)

print("Fixed background.js")
