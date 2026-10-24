document.querySelector('#reload-app')?.addEventListener('click', () => location.reload());

window.setTimeout(() => {
  const cover = document.querySelector('#loading-cover');
  if (!cover || cover.classList.contains('hidden')) return;
  cover.classList.add('failed');
  cover.querySelector('.spinner')?.classList.add('hidden');
  const message = cover.querySelector('span');
  if (message) message.textContent = '读取配置超时，请重试';
  document.querySelector('#reload-app')?.classList.remove('hidden');
}, 15000);
