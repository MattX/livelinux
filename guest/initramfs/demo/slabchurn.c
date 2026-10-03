/*
 * slabchurn: open and close many files in rounds (for the slab view).
 *
 * Each round, with a pause after every step:
 *   1. create and open N files in /tmp/slabchurn: every open allocates a
 *      struct file (filp), every new file a dentry and a shmem inode
 *   2. close every other fd: filp slabs are left half full (partial)
 *   3. close the rest: filp slabs become empty
 *   4. unlink the files: dentries and inodes are freed
 * After each step the matching /proc/slabinfo lines are printed, when the
 * caches have not been merged into others.
 *
 *   slabchurn [N] [pause-secs] [rounds]   (default 3000 files, 3 s, forever)
 */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#define DIR "/tmp/slabchurn"

static const char *caches[] = { "filp", "dentry", "shmem_inode_cache" };

static void report(const char *step, unsigned secs)
{
	char line[256], name[64];
	unsigned long active, total, objsize, perslab, pages, slabs;
	FILE *f = fopen("/proc/slabinfo", "r");
	unsigned i;

	printf("slabchurn: %s\n", step);
	while (f && fgets(line, sizeof(line), f)) {
		if (sscanf(line, "%63s %lu %lu %lu %lu %lu : tunables %*u %*u %*u : slabdata %*u %lu",
			   name, &active, &total, &objsize, &perslab, &pages, &slabs) != 7)
			continue;
		for (i = 0; i < sizeof(caches) / sizeof(caches[0]); i++)
			if (strcmp(name, caches[i]) == 0)
				printf("slabchurn:   %-18s %6lu/%-6lu objs in use, %4lu slabs of %lu x %lu B\n",
				       name, active, total, slabs, perslab, objsize);
	}
	if (f)
		fclose(f);
	fflush(stdout);
	sleep(secs);
}

int main(int argc, char **argv)
{
	int n = argc > 1 ? atoi(argv[1]) : 3000;
	unsigned secs = argc > 2 ? atoi(argv[2]) : 3;
	int rounds = argc > 3 ? atoi(argv[3]) : 0;
	struct rlimit rl;
	char path[64];
	int *fds, i, r;

	if (n < 1)
		n = 1;
	/* the default limit is 1024 open files; root may raise it */
	rl.rlim_cur = rl.rlim_max = n + 16;
	if (setrlimit(RLIMIT_NOFILE, &rl) < 0)
		perror("setrlimit");
	fds = calloc(n, sizeof(*fds));
	mkdir(DIR, 0755);
	printf("slabchurn: pid %d, %d files in %s\n", getpid(), n, DIR);
	report("start", secs);

	for (r = 0; !rounds || r < rounds; r++) {
		printf("slabchurn: round %d\n", r);
		for (i = 0; i < n; i++) {
			snprintf(path, sizeof(path), DIR "/f%d", i);
			fds[i] = open(path, O_RDWR | O_CREAT, 0644);
			if (fds[i] < 0) {
				perror(path);
				return 1;
			}
		}
		report("opened all", secs);
		for (i = 0; i < n; i += 2)
			close(fds[i]);
		report("closed every other fd", secs);
		for (i = 1; i < n; i += 2)
			close(fds[i]);
		report("closed all", secs);
		for (i = 0; i < n; i++) {
			snprintf(path, sizeof(path), DIR "/f%d", i);
			unlink(path);
		}
		report("unlinked all", secs);
	}
	rmdir(DIR);
	return 0;
}
