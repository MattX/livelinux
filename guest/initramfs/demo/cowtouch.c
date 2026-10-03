/*
 * cowtouch: fork, then write shared pages one by one (for the address-space
 * overlays: watch frames go from shared to private).
 *
 * The parent maps N anonymous pages and fills each with 'P', then forks. Both
 * processes now map the same frames, read-only, with copy-on-write pending.
 *   1. the child writes its pages one at a time, filling them with 'C': each
 *      write faults and the child gets a fresh copy of that page
 *   2. then the parent writes its pages: each frame is mapped only by the
 *      parent by now, so the fault reuses it in place (same frame, no copy)
 * Each page starts with a text header (owner, pid, index) for the hex view.
 *
 *   cowtouch [pages] [interval-ms]   (default 32 pages, 1000 ms)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static void fill(char *page, size_t pg, char c, int i)
{
	memset(page, c, pg);
	snprintf(page, 64, "cowtouch page %d written by %s pid %d", i,
		 c == 'C' ? "child" : "parent", getpid());
}

static void touch_all(const char *who, char *p, int n, size_t pg, char c, long ms)
{
	int i;

	for (i = 0; i < n; i++) {
		usleep(ms * 1000);
		fill(p + i * pg, pg, c, i);
		printf("cowtouch: %s pid %d wrote page %d at %p\n", who, getpid(), i,
		       (void *)(p + i * pg));
		fflush(stdout);
	}
}

int main(int argc, char **argv)
{
	int n = argc > 1 ? atoi(argv[1]) : 32;
	long ms = argc > 2 ? atol(argv[2]) : 1000;
	size_t pg = (size_t)sysconf(_SC_PAGESIZE);
	int done[2], i;
	char *p, c;
	pid_t pid;

	if (n < 1)
		n = 1;
	p = mmap(NULL, n * pg, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (p == MAP_FAILED) {
		perror("mmap");
		return 1;
	}
	for (i = 0; i < n; i++)
		fill(p + i * pg, pg, 'P', i);
	if (pipe(done) < 0) {
		perror("pipe");
		return 1;
	}
	fflush(stdout);
	pid = fork();
	if (pid < 0) {
		perror("fork");
		return 1;
	}
	if (pid == 0) {
		touch_all("child ", p, n, pg, 'C', ms);
		if (write(done[1], "x", 1) != 1)
			return 1;
		for (;;)
			pause();
	}

	printf("cowtouch: parent pid %d, child pid %d, %d pages at %p-%p\n", getpid(), pid, n,
	       (void *)p, (void *)(p + n * pg));
	fflush(stdout);
	if (read(done[0], &c, 1) != 1)
		return 1;
	touch_all("parent", p, n, pg, 'P', ms);
	printf("cowtouch: done; each of pid %d and pid %d has its own copy of all %d pages\n",
	       getpid(), pid, n);
	fflush(stdout);
	for (;;)
		pause();
}
