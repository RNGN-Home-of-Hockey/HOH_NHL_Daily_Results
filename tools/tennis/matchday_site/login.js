"use strict";
// A link to one match keeps its #matches/<id> through the login.
const form = document.getElementById("login");
if (/^#matches\/\d+$/.test(location.hash)) form.action = `/matchday/login${location.hash}`;
