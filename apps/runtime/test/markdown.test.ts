import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarkdownContent, SegmentText} from '../../desktop/src/MarkdownContent.js';

test('shared renderer preserves headings, nesting, tables, quotes and code without HTML or external image loading',()=>{
 const text='# Heading\n\n**Bold**\n\n1. Parent\n   - Child\n\n| Item | Value |\n| --- | --- |\n| Samples | 12 |\n\n> Uncertain\n\n```js\nconst x = 2;\n```\n\n![remote](https://example.test/private.png)\n\n<script>alert(1)</script>';
 const markup=renderToStaticMarkup(createElement(MarkdownContent,{text}));
 for(const expected of ['<h1>','<strong>','<ol>','<ul>','<table>','<blockquote>','<pre>','Scrollable table'])assert.ok(markup.includes(expected),expected);
 assert.doesNotMatch(markup,/<img|<script|src=|https:\/\/example/);assert.match(markup,/Samples/);
});

test('citations retain inspectable HTTP destinations while executable/local schemes stay inert',()=>{
 const markup=renderToStaticMarkup(createElement(MarkdownContent,{text:'[Source](https://example.com/evidence) [Local](file:///etc/passwd) [Code](javascript:alert)'}));
 assert.match(markup,/<a href="https:\/\/example.com\/evidence"/);assert.match(markup,/noopener noreferrer/);
 assert.doesNotMatch(markup,/href="(?:file|javascript):/);
});

test('the user\'s own words render as written while Moo\'s lines stay Markdown',()=>{
 const user=renderToStaticMarkup(createElement(SegmentText,{segment:{speaker:'user',text:'Moles: 2*3*4 = 24 and c1*V1 = c2*V2.\nIf x<y and y>z then x<z.\n# of moles stays the same.'}}));
 assert.doesNotMatch(user,/<em>|<h1>/);assert.match(user,/class="markdown plain-text"/);
 assert.ok(user.includes('Moles: 2*3*4 = 24 and c1*V1 = c2*V2.\nIf x&lt;y and y&gt;z then x&lt;z.\n# of moles stays the same.'),user);
 assert.match(renderToStaticMarkup(createElement(SegmentText,{segment:{speaker:'assistant',text:'**Bold** answer'}})),/<strong>Bold<\/strong>/);
});
