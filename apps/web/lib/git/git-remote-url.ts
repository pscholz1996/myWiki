// Converts a git remote URL (SSH or HTTPS form) into a browsable GitHub
// URL. Only github.com is supported — GitHub Enterprise Server hosts are
// out of scope.
export function remoteToHttpsUrl(remote: string | null): string | null {
  if (!remote) return null;

  const sshMatch = remote.match(/^git@github\.com:(.+?)(\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  const httpsMatch = remote.match(
    /^https:\/\/github\.com\/(.+?)(\.git)?$/,
  );
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}`;
  }

  return null;
}
