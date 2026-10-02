/* mapper: create a few interesting mappings, print /proc/self/maps, sleep. */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void)
{
	size_t pg = (size_t)sysconf(_SC_PAGESIZE);
	char *anon, *ro, *file;
	int fd;
	char line[256];
	FILE *f;

	/* anonymous RW region, touched so pages are present */
	anon = mmap(NULL, 16 * pg, PROT_READ | PROT_WRITE,
		    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (anon == MAP_FAILED) {
		perror("mmap anon");
		return 1;
	}
	memset(anon, 0xAA, 16 * pg);

	/* second anonymous region, split by mprotect into rw / r-- / --- parts */
	ro = mmap(NULL, 8 * pg, PROT_READ | PROT_WRITE,
		  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (ro == MAP_FAILED) {
		perror("mmap ro");
		return 1;
	}
	memset(ro, 0x55, 8 * pg);
	mprotect(ro + 2 * pg, 2 * pg, PROT_READ);
	mprotect(ro + 5 * pg, 1 * pg, PROT_NONE);

	/* file mapping (private, read-only) of /bin/busybox */
	fd = open("/bin/busybox", O_RDONLY);
	if (fd < 0) {
		perror("open /bin/busybox");
		return 1;
	}
	file = mmap(NULL, 4 * pg, PROT_READ | PROT_EXEC, MAP_PRIVATE, fd, 0);
	if (file == MAP_FAILED) {
		perror("mmap file");
		return 1;
	}
	(void)*(volatile char *)file;
	mprotect(file, pg, PROT_READ);

	printf("mapper: pid %d anon=%p ro=%p file=%p\n", getpid(),
	       (void *)anon, (void *)ro, (void *)file);
	f = fopen("/proc/self/maps", "r");
	if (f) {
		while (fgets(line, sizeof(line), f))
			fputs(line, stdout);
		fclose(f);
	}
	fflush(stdout);
	for (;;)
		sleep(1);
	return 0;
}
