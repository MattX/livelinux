/*
 * oomer: drive the kernel out of memory and watch the OOM killer pick victims.
 *
 * The parent makes itself unkillable (oom_score_adj -1000) and forks:
 *   small   holds  8 MB
 *   big     holds 32 MB
 *   bait    holds  8 MB but sets oom_score_adj to 1000, so it ranks first
 *   hog     grows by step-MB every interval until the OOM killer stops it
 * With no swap, the first OOM kill takes bait (smallest, but adj 1000 adds
 * all of RAM to its score); the hog keeps growing, and the second kill takes
 * the hog, now by far the largest. The parent prints each child's RSS and
 * /proc/PID/oom_score every second, reports each kill with the peak values it
 * saw, then cleans up.
 * The kernel's own OOM report also appears on the console.
 *
 *   oomer [step-MB] [interval-ms]   (default 1 MB, 50 ms)
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

struct child {
	const char *name;
	int mb, adj;
	pid_t pid;
	long rss_mb, score;
};

static struct child kids[] = {
	{ .name = "small", .mb = 8 },
	{ .name = "big", .mb = 32 },
	{ .name = "bait", .mb = 8, .adj = 1000 },
	{ .name = "hog" },
};
#define NKIDS (int)(sizeof(kids) / sizeof(kids[0]))
#define HOG (&kids[NKIDS - 1])

static void set_adj(int adj)
{
	FILE *f = fopen("/proc/self/oom_score_adj", "w");

	if (f) {
		fprintf(f, "%d\n", adj);
		fclose(f);
	}
}

static long read_long(pid_t pid, const char *file, int field)
{
	char path[64];
	long v = -1;
	FILE *f;

	snprintf(path, sizeof(path), "/proc/%d/%s", pid, file);
	f = fopen(path, "r");
	if (f) {
		while (field-- > 0 && fscanf(f, "%ld", &v) == 1)
			;
		fclose(f);
	}
	return v;
}

static char *grab(size_t mb)
{
	size_t len = mb << 20, off, pg = (size_t)sysconf(_SC_PAGESIZE);
	char *p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

	if (p == MAP_FAILED)
		return NULL;
	for (off = 0; off < len; off += pg)
		p[off] = 1;
	return p;
}

static void run_child(struct child *c, int step, long ms)
{
	long total = 0;

	set_adj(c->adj);
	if (c != HOG) {
		grab(c->mb);
		for (;;)
			pause();
	}
	usleep(500000); /* let the bystanders fill up first */
	for (;;) {
		if (!grab(step)) {
			printf("oomer: hog: mmap failed at %ld MB\n", total);
			exit(1);
		}
		total += step;
		usleep(ms * 1000);
	}
}

int main(int argc, char **argv)
{
	int step = argc > 1 ? atoi(argv[1]) : 1;
	long ms = argc > 2 ? atol(argv[2]) : 50;
	int i, st, alive = NKIDS, tick = 0;
	pid_t pid;

	if (step < 1)
		step = 1;
	set_adj(-1000);
	printf("oomer: parent pid %d (oom_score_adj -1000)\n", getpid());
	for (i = 0; i < NKIDS; i++) {
		fflush(stdout);
		kids[i].pid = fork();
		if (kids[i].pid < 0) {
			perror("fork");
			return 1;
		}
		if (kids[i].pid == 0)
			run_child(&kids[i], step, ms);
		printf("oomer: %-5s pid %d, oom_score_adj %4d, %s\n", kids[i].name, kids[i].pid,
		       kids[i].adj, &kids[i] == HOG ? "grows until killed" : "holds memory");
	}

	while (HOG->pid) {
		while ((pid = waitpid(-1, &st, WNOHANG)) > 0) {
			for (i = 0; i < NKIDS && kids[i].pid != pid; i++)
				;
			if (i == NKIDS)
				continue;
			if (WIFSIGNALED(st))
				printf("oomer: %s (pid %d) killed by signal %d (%s); peak %ld MB, oom_score %ld\n",
				       kids[i].name, pid, WTERMSIG(st), strsignal(WTERMSIG(st)),
				       kids[i].rss_mb, kids[i].score);
			else
				printf("oomer: %s (pid %d) exited with status %d\n", kids[i].name, pid,
				       WEXITSTATUS(st));
			kids[i].pid = 0;
			alive--;
		}
		/*
		 * Keep the peaks: once a child is picked, the OOM reaper empties
		 * its mm and its score reads 0 before we get to reap it.
		 */
		for (i = 0; i < NKIDS; i++) {
			long rss, score;

			if (!kids[i].pid)
				continue;
			rss = read_long(kids[i].pid, "statm", 2) * 4 / 1024;
			score = read_long(kids[i].pid, "oom_score", 1);
			if (rss > kids[i].rss_mb)
				kids[i].rss_mb = rss;
			if (score > kids[i].score)
				kids[i].score = score;
		}
		if (alive && tick++ % 10 == 0) {
			printf("oomer:");
			for (i = 0; i < NKIDS; i++)
				if (kids[i].pid)
					printf(" %s %ld MB score %ld |", kids[i].name, kids[i].rss_mb,
					       kids[i].score);
			printf("\n");
		}
		fflush(stdout);
		usleep(100000);
	}

	for (i = 0; i < NKIDS; i++)
		if (kids[i].pid) {
			kill(kids[i].pid, SIGKILL);
			waitpid(kids[i].pid, NULL, 0);
		}
	printf("oomer: done\n");
	return 0;
}
