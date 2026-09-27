import os from 'node:os';
// Windows sandbox accounts may block libuv's passwd lookup. tsx only uses this
// metadata for its cache path; keep the lookup on local environment values.
os.userInfo = () => ({
  uid: -1,
  gid: -1,
  username: process.env.USERNAME || 'orion',
  homedir: process.env.USERPROFILE || process.cwd(),
  shell: process.env.COMSPEC || 'cmd.exe',
});
