/*
 * fragmenter: fragment physical memory with mmap/munmap (for the buddy view).
 *
 * Each round, with a pause after every step:
 *   1. grab: mmap MB of anonymous memory and touch every page; faults take
 *      pages off the per-CPU lists, which refill by splitting large buddy blocks
 *   2. punch: munmap every other page; the freed pages cannot merge with their
 *      still-allocated buddies, so free memory grows but only at order 0
 *   3. release: munmap the rest; buddies find each other and merge back up
 * /proc/buddyinfo is printed after each step.
 *
 * Freed pages go to the per-CPU page lists first, and 6.12 lets those grow to
 * 1/8 of the zone, which would hide all of this from the buddy allocator. So
 * while it runs, fragmenter caps them by raising
 * vm.percpu_pagelist_high_fraction (high = 4 batches, ~60 pages), and puts
 * the old value back on exit, SIGINT or SIGTERM.
 *
 *   fragmenter [MB] [pause-secs] [rounds]   (default 32 MB, 5 s, forever)
 *   fragmenter -d ...                       punch with madvise(MADV_DONTNEED)
 *                                           instead, keeping a single VMA
 *                                           (munmap leaves one VMA per page)
 */
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define PCP_FRACTION "/proc/sys/vm/percpu_pagelist_high_fraction"

static char old_fraction[32];

/* async-signal-safe: also called from the signal handler */
static int set_fraction(const char *v)
{
	int fd = open(PCP_FRACTION, O_WRONLY), ok;

	if (fd < 0)
		return 0;
	ok = write(fd, v, strlen(v)) > 0;
	close(fd);
	return ok;
}

static void restore(int sig)
{
	if (old_fraction[0])
		set_fraction(old_fraction);
	if (sig)
		_exit(128 + sig);
}

static void report(const char *step, unsigned secs)
{
	char line[256];
	FILE *f = fopen("/proc/buddyinfo", "r");

	printf("fragmenter: %s\n", step);
	while (f && fgets(line, sizeof(line), f))
		printf("fragmenter:   %s", line);
	if (f)
		fclose(f);
	fflush(stdout);
	sleep(secs);
}

int main(int argc, char **argv)
{
	int dontneed = argc > 1 && strcmp(argv[1], "-d") == 0;
	char **args = argv + dontneed;
	int nargs = argc - dontneed;
	size_t mb = nargs > 1 ? atoi(args[1]) : 32;
	unsigned secs = nargs > 2 ? atoi(args[2]) : 5;
	int rounds = nargs > 3 ? atoi(args[3]) : 0;
	size_t pg = (size_t)sysconf(_SC_PAGESIZE);
	size_t len = mb << 20, off;
	FILE *f = fopen(PCP_FRACTION, "r");
	char *p;
	int r;

	if (f) {
		if (!fgets(old_fraction, sizeof(old_fraction), f))
			old_fraction[0] = 0;
		fclose(f);
	}
	signal(SIGINT, restore);
	signal(SIGTERM, restore);
	if (!set_fraction("100000"))
		printf("fragmenter: cannot cap the per-CPU page lists; frees may not reach the buddy lists\n");
	printf("fragmenter: pid %d, %zu MB, punching with %s\n", getpid(), mb,
	       dontneed ? "madvise(MADV_DONTNEED)" : "munmap");
	report("start", secs);
	for (r = 0; !rounds || r < rounds; r++) {
		p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (p == MAP_FAILED) {
			perror("mmap");
			restore(0);
			return 1;
		}
		for (off = 0; off < len; off += pg)
			p[off] = 1;
		printf("fragmenter: round %d at %p-%p\n", r, (void *)p, (void *)(p + len));
		report("grabbed", secs);

		for (off = 0; off < len; off += 2 * pg)
			if (dontneed)
				madvise(p + off, pg, MADV_DONTNEED);
			else
				munmap(p + off, pg);
		report("punched every other page", secs);

		if (dontneed)
			munmap(p, len);
		else
			for (off = pg; off < len; off += 2 * pg)
				munmap(p + off, pg);
		report("released", secs);
	}
	restore(0);
	return 0;
}
