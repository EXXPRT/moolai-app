import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarkdownContent} from '../../desktop/src/MarkdownContent.js';

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
